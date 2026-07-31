# WINE AI — Migration Plan: PostgreSQL as Single Source of Truth

Status: approved (audit accepted)
Date: 2026-07-31
Scope: plan only — no working code changed. Every claim references current code locations.

Goal: Postgres owns the full knowledge system (catalog + knowledge base + management). `knowledge/source/*.md` and `knowledge/index/index.json` become import source / emergency fallback only, removed from the runtime path on a tested schedule.

---

## 0. Target data model (logical separation in Postgres)

| Domain | Tables |
|---|---|
| Structured catalog | `entity_facts`, `entity_facts_provenance`, `kos_sources`, `kos_source_documents`, `kos_source_document_versions` (+ later `wines`/`offers` if catalog columns are needed) |
| Knowledge base | `kos_source_documents` (documents), `knowledge_chunk_embeddings` (chunks + embeddings), plus one new table `knowledge_chunks` (chunk text/metadata, see §3) |
| Management | `knowledge_crawl_runs`, `kos_crawl_runs`, `kos_crawl_run_items`, `knowledge_documents` (discovered store), `app_settings`, new `knowledge_imports`/`knowledge_errors` (optional, §3) |

---

## 1. What we keep (no rewrite)

- **`search()` algorithm and hybrid fusion** (`src/knowledge/search.js`) — keyword IDF, entity layer, `semanticCandidateIds`, RRF reranking (`search.js:153-180`, `:465-565`). Only its **data source** changes (chunk set), not its logic.
- **`buildQueryVariants` / `runBoundedRetrieval` / `setSearchBlock`** (`src/tools/searchWineKnowledge.js:32-122`) — the `searchWineKnowledge` contract stays byte-identical to the LLM (see §5).
- **Entity resolver** (`src/knowledge/entityResolver.js`) — aliases stay in `knowledge/entity-aliases.json`; add PG mirror only if aliases become editable.
- **Wine.md extractor / classifier / crawler** (`src/kos/extraction/*`, `src/kos/sources/crawlIngestionService.js`) — already PG-only since `1594e8f`.
- **Embeddings module** (`src/knowledge/embeddings.js`) — Gemini `gemini-embedding-001`, unchanged.
- **KOS schema migrations** (`src/kos/db/kosSchema.js`, v1–v6) and `src/knowledge/db.js` schema init — extend, don't fork.

## 2. Tables that already fit (no structural migration)

- `kos_source_documents` — already the "active knowledge" set (`status='active'` filter in `buildIndexFromPostgres`, `src/knowledge/index.js:46-48`). Document source of truth: **yes**.
- `knowledge_chunk_embeddings` — chunks → embeddings (pgvector, `src/knowledge/db.js:94-110`). Needs a text/metadata companion table (chunk text is not stored), see §3.
- `knowledge_documents` — discovered/crawl queue + promote source (`src/knowledge/discovered/store.js`). Already PG-backed when `DATABASE_URL` set.
- `app_settings` — search-mode persistence (`src/knowledge/searchMode.js:42-52`). Unchanged.
- `kos_sources`, `kos_crawl_runs`, `kos_crawl_run_items`, `knowledge_crawl_runs` — management, already PG.

## 3. Minimal migrations needed (new, additive only)

1. **`knowledge_chunks`** (new table) — the missing piece. Mirrors the shape of a chunk in `index.json` so `search()` can consume it directly:
   - `chunk_id TEXT PRIMARY KEY` (same id scheme as today), `source_file TEXT`, `title TEXT`, `doc_type TEXT`, `language TEXT`, `source TEXT`, `confidence TEXT`, `winery/region/grape/entity_id TEXT`, `text TEXT NOT NULL`, `enabled BOOLEAN DEFAULT true`, `content_hash TEXT`, `created_at/updated_at`.
   - Chunks keyed by `chunk_id` line up with `knowledge_chunk_embeddings.chunk_id` (1:1, same pk).
2. **`kos_source_documents` backfill columns** (if not present) — `title`, `language`, `doc_type`, `confidence` already exist; verify `entity_id`-style metadata is available for chunk metadata (currently `buildIndexFromPostgres` hardcodes `confidence:'unverified'`, `entity_id:null` at `src/knowledge/index.js:59-61`). Add nullable metadata columns if a source row needs them.
3. **`knowledge_imports` / `knowledge_errors`** (optional, small) — import runs, per-document status/errors, history. Fills the "management" bucket; not required for the switch itself.

Everything else is **logic wiring, not schema**.

## 4. How to move runtime search to Postgres

The seam is `search()` reading a chunk set. Today it reads `loadIndex()` (`search.js:411`). Plan:

- **Add a chunk-source selector** in `src/knowledge/index.js`: `loadChunks({ source })` returning the same `{chunks:[...]}` shape from either `loadIndex()` (file fallback) or a new `loadChunksFromPostgres(pool)` (reads `knowledge_chunks` + joins `knowledge_chunk_embeddings` for embed presence).
- `search()` reads chunks via the selector; `keywordSearch`/`entityHits`/`aliasTextSearch`/`chunkById` keep operating on that in-memory chunk array **unchanged**.
- `semanticCandidateIds` already queries PG (`search.js:153-169`) — no change; it just starts matching PG chunks instead of file chunks.
- Remove the file-write from `buildIndex()` flows when PG is active: `scripts/knowledge-index.js`, `server.js:1474`, `updateCycle.js:185` switch to "populate `knowledge_chunks`" (`buildIndexFromPostgres` already returns `{documents, chunks}`; add an upsert pass into `knowledge_chunks`).
- `knowledge-embed-backfill.js` reads chunks from `knowledge_chunks` instead of `loadDocuments(DEFAULT_SOURCE_DIR)` (`:57`), and prunes against PG chunk ids (`:100-107`).

## 5. Preserving the `searchWineKnowledge` contract

Contract (what the LLM and tests see) must not change:

- `declaration` (name/description/params, `searchWineKnowledge.js:6-20`) — frozen.
- `impl` return shapes: `{found,status:'error'|'not_found'|'found',results,instruction}` (`searchWineKnowledge.js:141-199`) — frozen.
- `results[].{text,title,source,confidence,language,relevance_score}` — sourced from chunk metadata (which PG chunks now provide); keep the same trust-sort (`:184-193`).
- `setSearchBlock` behavior (`toolHelpers`) — untouched.
- Guards: `tests/tools.test.js:19-24`, `tests/stage1_safetyGate.test.js` (search-block on not_found), `tests/searchWineKnowledgeFallback.test.js` must stay green with PG as the source (see §8).

The tool never talks to storage directly — it only calls `search()` — so keeping `search()`'s return shape stable preserves the contract automatically.

## 6. Migrating existing file documents

One-time import script (new, additive — does not delete files):

- Read `knowledge/source/*.md` via `loadDocuments()` (`src/knowledge/loader.js:120`), chunk via `chunkDocument()`.
- Upsert documents into `kos_source_documents` (idempotent on `(source_id, canonical_url)`; reuse logic from `migrateCrawledData.js`).
- Upsert chunks into `knowledge_chunks`; run embedding backfill for new chunk ids.
- Keep the files in place as fallback; do **not** delete until the switch is proven (§9).
- The 330 `discovered-*.md` files stay as git history; after PG is authoritative they can be git-removed in a separate, reviewed commit (not part of the runtime switch).

## 7. Temporary fallback (migration window)

- `loadChunks({source})`: `'postgres'` → `'file'` → error. Gate on `db.isEnabled()` (`src/knowledge/db.js:12-14`), same pattern the rest of `src/knowledge/*` already uses.
- If PG chunk load fails (query error / empty table) → fall back to `loadIndex()` (`index.json`) so search never hard-fails during migration.
- `prestart` keeps working: `knowledge-republish.js && knowledge-index.js && knowledge-embed-backfill.js` (`package.json:8`) keep maintaining files during the window; a new `knowledge-chunks-sync.js` step (or the same scripts, PG-aware) keeps `knowledge_chunks` fresh.
- Add a startup log line: which source is active (`[knowledge] chunk source: postgres|file`).

## 8. When to remove the `index.json` dependency

Only after all of these pass on the same deployed environment (Railway, DATABASE_URL set):

1. `loadChunks({source:'postgres'})` returns ≥ the file index's 361 docs / 860 chunks (plus any PG-only uploads).
2. §5 contract tests + `tests/knowledgeSearch.test.js` (all cases, including entity-address and disabled-entity) pass with PG source **and** with file source.
3. `npm run test:smoke` + `npm run smoke:knowledge` pass against a freshly started server.
4. `tests/benchmark/retrieval-benchmark.js` (non-hybrid) passes with PG source; `--hybrid` passes when embeddings present.
5. Live HTTP check: upload a doc via `/api/knowledge/upload`, then `search()` returns it (proves the original audit defect is fixed).
6. Full `npm test` + `npm run test:smoke` + `npm run check:missing-imports` green on the migration branch.

Only then: (a) make PG the default source, (b) drop the file-fallback branch in `loadChunks`, (c) remove `index.json` writes from `prestart`/`reindex`/`updateCycle`, (d) remove file import script, (e) separate commit to delete `discovered-*` files from git.

## 9. Tests & benchmarks that prove the switch

| Check | Where | Purpose |
|---|---|---|
| New `knowledgeChunksStorage.test.js` | unit | PG chunk upsert/read round-trip, idempotency, embed join |
| New `searchPgSource.test.js` | unit | same assertions as `knowledgeSearch.test.js` but with `loadChunks({source:'postgres'})` |
| `searchWineKnowledgeFallback.test.js` | unit | contract (known failing test 3 must be fixed alongside — pre-existing drift) |
| `tools.test.js`, `stage1_safetyGate.test.js` | unit | tool contract + search-block behavior |
| `postgresPersistence.test.js` | unit | PG-first invariants (currently mostly static-file assertions) |
| `retrieval-benchmark.js` / `--hybrid` | benchmark | relevance parity: PG source vs file source, top-1/top-3, no-contamination |
| `grounding-benchmark.js` | benchmark | end-to-end grounding |
| `npm run test:smoke` + `smoke:knowledge` | smoke | boot + search path |
| `npm run check:missing-imports` | gate | no untracked imports |
| Live `/api/knowledge/upload` → `search()` | manual/HTTP | proves uploads become searchable (audit §6, root defect) |

## 10. Stage plan (small steps, no big-bang)

| Stage | Change | Affected components | Risk |
|---|---|---|---|
| **1. Chunk storage (recommended first step)** | Add `knowledge_chunks` table + `loadChunksFromPostgres()`; add `scripts/knowledge-chunks-sync.js` that populates it from `buildIndex()`/`buildIndexFromPostgres()` output. No runtime switch yet. | `src/knowledge/db.js`, `src/knowledge/index.js`, new script | Low — additive, nothing reads it yet |
| **2. Read path switch (feature-flagged)** | `loadChunks({source:'postgres'|'file'|'auto'})` in `search()`; default `auto` = PG if `db.isEnabled()` else file; log active source. | `src/knowledge/index.js`, `src/knowledge/search.js` | Medium — changes what search returns; gated by fallback + tests |
| **3. Write path switch** | Upload (`server.js:1374`) persists `buildIndexFromPostgres` result into `knowledge_chunks`; `knowledge-embed-backfill.js` reads PG chunks; `reindex`/`updateCycle`/`prestart` populate PG chunks. | `src/server.js`, `scripts/knowledge-embed-backfill.js`, `scripts/knowledge-index.js`, `updateCycle.js` | Medium — fixes the audit's upload defect |
| **4. Import existing files** | New import script (files → `kos_source_documents` + `knowledge_chunks` + embeddings); run once in prod; keep files as fallback. | new script, `src/kos/sources/migrateCrawledData.js` (reuse) | Low-Medium — one-time, idempotent |
| **5. Prove & freeze** | §8 gate list green in prod; make PG default; drop file fallback branch; remove `index.json` writes. | `prestart` (`package.json:8`), `scripts/*`, `src/knowledge/index.js` | Medium — the actual cutover |
| **6. Cleanup** | Delete `discovered-*` files from git; remove import script; update docs. | git, docs | Low |

## 11. Risks

1. **Chunk id drift** — file index and PG chunks must share the same `chunk_id` scheme (today it's `sourceFile:title-ish`; `buildIndexFromPostgres` uses `postgres:<id>`). Verify id stability in Stage 1, else embeddings break their 1:1 join.
2. **Embedding prune bug** — `knowledge-embed-backfill.js:100-107` deletes embeddings for chunks not in its chunk set; if PG chunks and embeddings are loaded from different sources during migration, embeddings get pruned. Fix prune source in Stage 3 before any PG-only chunk exists.
3. **Fallback masking the defect** — silent `index.json` fallback could hide PG failures in prod. The startup log line (Stage 2) is mandatory to detect it.
4. **Search-mode regression** — `disabled`/`keyword`/`hybrid` paths in `search()` (`search.js:406-415`, `:468-492`) must behave identically with PG chunks.
5. **Performance** — loading 860+ chunks from PG per request may be slower than `JSON.parse`. Cache the chunk set in memory (keyed by a `knowledge_chunks` max-`updated_at` watermark), same cache pattern as `_aliasCacheByPath` (`entityResolver.js:32`).

## 12. Recommended first small step

**Stage 1 only:** add `knowledge_chunks` table and `scripts/knowledge-chunks-sync.js` (populate PG chunks from the current `buildIndex()` output, idempotent upsert, dry-run mode). No runtime behavior changes, nothing reads it yet. It establishes chunk-id stability, the embed join, and the storage round-trip before any search path is touched — de-risking every later stage.

Verify Stage 1 with: new unit test (PG chunk round-trip + idempotency), `npm test` on the touched modules, and (if `DATABASE_URL` available locally) the postgres integration tests.

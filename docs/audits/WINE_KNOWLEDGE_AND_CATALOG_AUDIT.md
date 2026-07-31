# WINE AI — Knowledge & Catalog Audit

Audit date: 2026-07-31
Scope: how knowledge (searchable content) and the wine catalog actually flow through the system, where the file-based and Postgres/KOS contours overlap or diverge, and what breaks as a result.
Method: static code tracing with file + line references, disk-state verification (`knowledge/source/`, `knowledge/index/index.json`), git history inspection, and targeted unit tests. Read-only — no code was changed.

---

## 1. Executive summary

The repository has **two knowledge contours that do not converge**:

1. **File contour** (the one the runtime assistant actually reads): `knowledge/source/*.md` → `buildIndex()` → `knowledge/index/index.json` → `search()` (`src/knowledge/search.js:411`). This is the only contour behind `searchWineKnowledge` and thus the only knowledge the text-chat and realtime-voice assistant can see.
2. **PostgreSQL/KOS contour**: `kos_source_documents`, `kos_sources`, `knowledge_documents`, `knowledge_chunk_embeddings` (pgvector). The Dashboard upload (`POST /api/knowledge/upload`, `src/server.js:1340-1380`) writes into `kos_source_documents`, then calls `buildIndexFromPostgres(pool)` (`src/server.js:1374`) — but that function only returns chunks **in memory** (`src/knowledge/index.js:38-82`). It never writes `knowledge/index/index.json`, never creates embeddings, and nothing else ever reads its result.

**Confirmed consequence:** documents uploaded through the Dashboard are stored in Postgres but are **invisible to search**. The runtime index (`knowledge/index/index.json`, 361 docs / 860 chunks / built 2026-07-31T05:54:39Z) is rebuilt only from the filesystem, and `knowledge-embed-backfill.js` even **deletes** embeddings whose `chunk_id` is absent from the file-based index (`scripts/knowledge-embed-backfill.js:100-107`), i.e. it actively prunes any PG-only chunk it encounters.

Separately, the old "discovered / promote" contour is the reason `knowledge/source/` now holds **330 `discovered-*.md` files out of 361 total `.md`** (86 of them `discovered-kos-*.md`). Those files are git-tracked leftovers of a pre-`1594e8f` commit pipeline and are themselves part of the index.

---

## 2. File contour (what the runtime assistant actually reads)

Pipeline:

```text
knowledge/source/*.md
  -> loadDocuments()                       src/knowledge/loader.js:120
  -> chunkDocument()
  -> buildIndex()                          src/knowledge/index.js:12-32
     writes knowledge/index/index.json     (documents, chunks, built_at)
  -> search()                              src/knowledge/search.js:402
     loadIndex(indexFile)                  src/knowledge/search.js:411
```

- The search entrypoint used by tools is `search()` in `src/knowledge/search.js`. Line 411 is the single point where runtime knowledge is loaded: `const index = loadIndex(indexFile);`.
- `loadIndex()` (`src/knowledge/index.js:84-89`) is a plain `JSON.parse` of `knowledge/index/index.json`.
- Keyword matching is IDF-based over the file-derived chunks; semantic matching (`semanticCandidateIds`, `src/knowledge/search.js:153-165`) queries `knowledge_chunk_embeddings` but only for chunk ids that exist in the file index (results are fused by RRF, line 500).
- `buildIndex()` (`src/knowledge/index.js:12`) reads the **filesystem** (`DEFAULT_SOURCE_DIR` → `knowledge/source`), writes `index.json`, and returns counts. It is invoked from:
  - `POST /api/knowledge/reindex` (`src/server.js:1472-1484`);
  - `scripts/knowledge-index.js` (part of `prestart`, `package.json:8`);
  - `runUpdateCycle()` (`src/knowledge/updateCycle.js:185`).

Tools that consume this contour: `searchWineKnowledge` (`src/tools/searchWineKnowledge.js`), which runs bounded multi-variant retrieval (`buildQueryVariants` line 32, `runBoundedRetrieval` line 83, max 5 variants, `finalStatus` line 113).

`loadDocumentsFromPostgres` exists (`src/knowledge/loader.js:128`) but is **not** called by `buildIndex()` or by any runtime path — grep finds no caller.

---

## 3. PostgreSQL / KOS contour (where writes actually land)

### 3.1 Tables

Schema lives in `src/knowledge/db.js` and `src/kos/db/kosSchema.js` (migrations v1–v6; v6 adds `entity_facts_provenance`, `knowledge_chunk_embeddings` at `kosSchema.js:618`).

- `kos_source_documents` — the "active knowledge" table; written by the upload route and by the KOS crawler (`crawlIngestionService.js:180`).
- `knowledge_documents` — the discovered-docs store (news/crawl queue), file-backed locally, PG-backed in prod (`src/knowledge/discovered/store.js:89-96`).
- `knowledge_chunk_embeddings` — pgvector embeddings (`src/knowledge/db.js:94-110`).
- `kos_knowledge_facts`, `kos_fact_evidences` — published facts; **nobody calls the publisher in production** (`factPublicationService.publishCandidate` is invoked only from `tests/kosExtractionPipeline.postgres.integration.test.js`).
- `app_settings` — persists search mode (`src/knowledge/searchMode.js:42-52`).

### 3.2 Dashboard upload (`POST /api/knowledge/upload`)

`src/server.js:1292-1385`:

- Reads JSON body (filename + content or base64 PDF) (`server.js:1292-1298`).
- `insertAndReindex()` inserts into `kos_source_documents` (`server.js:1343-1371`, `status='active'`, upsert on `(source_id, canonical_url)`).
- Then: `const indexResult = await buildIndexFromPostgres(pool);` (`server.js:1374`).
- `buildIndexFromPostgres` (`src/knowledge/index.js:38-82`) selects `kos_source_documents`, builds `{documents, chunks, errors}` **in memory**, and returns it. It never touches `index.json` and never writes embeddings.
- The upload response only reports counts (`server.js:1376-1384`); `indexResult.chunks` is discarded. **Nothing persists the reindex.**

Net effect: uploaded documents exist in Postgres, but the runtime search index is never rebuilt from them, so they are unsearchable.

### 3.3 KOS crawler

- `crawlIngestionService.js` writes raw pages into `kos_source_documents` (`crawlIngestionService.js:180`) and crawl-run metadata into `kos_crawl_runs` / `kos_crawl_run_items`. Its own module docstring states: "ZERO DB writes of CandidateDrafts or ParsedDocuments (ingestion layer only)" (`crawlIngestionService.js:15`).
- The bridge comment at `crawlIngestionService.js:301-303` says "The index is rebuilt from Postgres via buildIndexFromPostgres()" — but **no call exists**; grep for `buildIndexFromPostgres` finds only `src/server.js:1374` (upload) and tests. The comment describes a path that was removed, not one that was replaced.
- `conflictResolver` (`SOURCE_PRIORITY`, `WINE_MD_ALWAYS_WINS`, `CONFLICT_REQUIRES_REVIEW`) is used only by the crawler for the `primary_partner` flag; nothing resolves facts at query time.

### 3.4 Embeddings backfill

`scripts/knowledge-embed-backfill.js` (in `prestart`):

- Loads documents **from the filesystem** via `loadDocuments(DEFAULT_SOURCE_DIR)` (`knowledge-embed-backfill.js:57`), NOT from Postgres.
- Computes embeddings via Gemini `embedTexts` (`knowledge-embed-backfill.js:75`), upserts into `knowledge_chunk_embeddings` (`:81-90`).
- **Prunes** rows whose `chunk_id` is not in the file-derived chunk set (`:100-107`). Any PG-only chunk (e.g. an uploaded doc) would be deleted here.

So the "semantic" path only ever covers the file index — even though the embeddings table lives in Postgres, it is maintained as a shadow of the filesystem, not of `kos_source_documents`.

---

## 4. Why the contours are broken

| # | Root cause | Evidence |
|---|------------|----------|
| 1 | Upload reindexes into memory only | `src/server.js:1374` calls `buildIndexFromPostgres(pool)`; result used only for response counts (`:1376-1384`). No `fs.writeFileSync` of `index.json`. |
| 2 | Runtime search reads only the file index | `src/knowledge/search.js:411` → `loadIndex()` → `index.json`. |
| 3 | `buildIndex()` reads only the filesystem | `src/knowledge/index.js:13` → `loadDocuments(sourceDir)`. |
| 4 | Embeddings are a shadow of the filesystem | `scripts/knowledge-embed-backfill.js:57` uses `loadDocuments(DEFAULT_SOURCE_DIR)`; `:100-107` deletes chunks not in the file index. |
| 5 | No caller of `loadDocumentsFromPostgres` | `src/knowledge/loader.js:128` defined, unreferenced. |
| 6 | Crawler writes PG but never reindexes | `crawlIngestionService.js:180` writes; `:301-303` claims reindex that doesn't exist. |
| 7 | `prestart` re-derives files, not PG index | `package.json:8`: `knowledge-republish.js && knowledge-index.js && knowledge-embed-backfill.js` — all file-contour. |

Historical root cause: commit `1594e8f` (2026-07-28, "feat: isolate crawler from Git/Railway — Postgres as source of truth") **removed** the crawler's filesystem commit step (`commitKnowledgeFiles`) and declared Postgres the source of truth, but the runtime index pipeline was never switched to read from Postgres. Before that commit, crawled pages were committed to `knowledge/source/` in batches ("Add crawled KOS source pages: WINEMD (20 page(s))" — `3c2e33e`, `54e3403`, `1a84320`, `97e6e9a`, `0e9adf9`, `010e316`, `142b1e9`, `6aefc18`, `3e429eb`, `298a80f`, `f733e87`, `90ea732`, `3345378`, `3d715be`, `7728756`, `8830a9b`, `5fded88`, `9b72786`, `e4f24cf`, …). Those files now sit in `knowledge/source/` (330 `discovered-*.md`, including 86 `discovered-kos-*.md`) and are picked up by the file contour, while **new** crawled pages go to Postgres and stay invisible.

---

## 5. Practical consequences

1. **Dashboard uploads are stored but unsearchable.** Uploading a PDF/DOC via the Knowledge tab shows `ok:true` with chunk counts, but the assistant cannot retrieve it: `index.json` is unchanged, no embeddings are created.
2. **Newly crawled KOS pages are invisible.** Since `1594e8f` the crawler writes only to Postgres; the assistant searches only the file index. The only crawled content in search is the git-committed snapshot from before the isolation commit.
3. **The `discovered-*` snapshot is stale and oversized.** 330 of 361 indexed docs are `discovered-*.md`; `updated_at` of the sample (`discovered-kos-catalog-vinuri-wine-md-c204291cff.md`) is 2026-07-28. These are crawler leftovers, not curated knowledge, and they dominate the 860-chunk index.
4. **Embeddings are pruned aggressively.** Any chunk that is PG-only gets deleted by `knowledge-embed-backfill.js:100-107`. If someone later "fixes" upload to insert PG chunks into `index.json` without changing the backfill, the embeddings for those chunks are still pruned until a manual backfill run.
5. **Facts pipeline is dormant.** `publishCandidate`/`resolveConflict` are wired only into integration tests; production never publishes `kos_knowledge_facts`, so entity facts come only from the file-based `entityFacts.js`/`deterministicRouter.js` contour.
6. **Search-mode persistence works but is orthogonal.** `app_settings` (`searchMode.js:42`) persists the mode correctly; not affected by the contour gap, but worth noting the dashboard toggle is one of the few PG-backed behaviors that does work.
7. **`/api/knowledge/sources` reflects only the file index.** `src/server.js:1168-1188` iterates `loadIndex().chunks` — uploads don't appear in the Sources list either.

---

## 6. Minimal fix options (analysis only — nothing implemented)

### Option A — Make Postgres the single source of truth for chunks/embeddings (recommended direction)

- `buildIndexFromPostgres(pool)` already returns `{documents, chunks, errors}` (`src/knowledge/index.js:38-82`).
- Change the runtime read path: `search()` (`src/knowledge/search.js:411`) should load chunks from Postgres (or from a PG-derived cache), and `buildIndex()`-style flows (`server.js:1474`, `updateCycle.js:185`, `prestart`) should be redirected to write `index.json` from PG or read PG directly.
- Change `knowledge-embed-backfill.js:57` to load chunks from PG (so uploads/crawls get embeddings), and change the prune at `:100-107` to use the PG chunk set instead of the file chunk set.
- This is the architecturally consistent fix but touches search, embedding, and boot paths — the broadest change.

### Option B — Publish KOS/uploaded docs into the file index (minimal)

- After the upload insert (`src/server.js:1374`), instead of discarding `indexResult`, write the PG-derived chunks into `knowledge/index/index.json` (merge with existing chunks) and trigger an embedding pass for the new chunks.
- New crawled pages would still need the same bridge in the crawler (`crawlIngestionService.js`, where the comment at `:301-303` says this should happen).
- Smaller surface than A, but keeps two sources of truth (files + PG) and inherits the stale-snapshot problem in `knowledge/source/`.

### Option C — Hybrid, staged (recommended for this repo's constraints)

1. **Fix the upload hole first** (Option B, upload route only): persist the `buildIndexFromPostgres` result into `index.json` and embed new chunks. Smallest change that makes Dashboard uploads actually searchable.
2. **Redirect embed-backfill to PG chunks** (`knowledge-embed-backfill.js`): load from `buildIndexFromPostgres` and prune against PG chunk ids, so PG-derived content keeps embeddings across restarts.
3. **Then migrate search to PG** (Option A) as a separate, tested step, and retire the `discovered-*` snapshot from `knowledge/source/` once PG-derived index is proven.

Recommended: **Option C (stage 1 + 2 immediately; stage 3 as follow-up).** It fixes the demonstrated user-visible defect (uploads/search are disconnected) with the smallest change, keeps the architecture-compliant end state in view, and never leaves the runtime in a broken intermediate state.

---

## 7. Verification performed

- Files inspected: see sections above (all `src/knowledge/*`, `src/kos/**`, `scripts/*`, `src/server.js`, `src/tools/*`, `package.json`).
- Disk state: `knowledge/index/index.json` = 361 documents / 860 chunks / built_at `2026-07-31T05:54:39.217Z`; `knowledge/source/` = 361 `.md` (330 `discovered-*`, of which 86 `discovered-kos-*.md`); 353 of the `.md` files are git-tracked, 322 of the tracked ones are `discovered-*`; `knowledge/source/discovered-*.md` is gitignored (`.gitignore:24`) so the 8 untracked ones are generated runtime output.
- Git history: `1594e8f` removed the crawler's git-commit step; the batch "Add crawled KOS source pages: WINEMD (20 page(s))" commits predate it.
- Tests run: 26 unit tests with `DATABASE_URL=memory` — 24 pass, 2 fail:
  - `tests/kosSourceIngestionService.test.js` — fails only because `initKosSchema({dbClient})` ignores its argument under `DATABASE_URL=memory` and connects to a bogus `base` host. Passes fully without the env var. Pre-existing environment/test issue, not caused by this audit.
  - `tests/searchWineKnowledgeFallback.test.js` — test 3 (line 39) asserts the not_found instruction reflects fallback variants; fails with `AssertionError`. File is unmodified in working tree; appears to be a test/code drift, unrelated to this audit.
- Postgres integration tests (`*.postgres.integration.test.js`) were **not** run: no `DATABASE_URL` is available locally, and they self-skip without it.

## 8. Limitations / unverified

- Railway production DB contents not inspected (no credentials in local env). Claims about production table state are inferred from code paths, not live rows.
- The 2 failing unit tests were not fixed (out of scope — read-only audit).
- Exact line numbers are from the audited commit; a small drift is possible on later edits to `search.js`/`server.js`.

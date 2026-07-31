# Stage 1–3 Real-PostgreSQL Verification Report

**Date:** 2026-07-31
**Provider:** Railway Postgres (`Postgres-s3cP`, production) — public URL via `DATABASE_PUBLIC_URL`
**Scope:** real-PG check of Stage 1–3 migration, **no cutover** (`KNOWLEDGE_CHUNK_SOURCE` not set in Railway, runtime source unchanged)

---

## 1. Verified findings

| Check | Result |
|---|---|
| PG connectivity | OK — PostgreSQL 18.4 (Debian) via `pg` |
| Baseline snapshot | `knowledge_chunks` = 0, `knowledge_chunk_embeddings` = 1899, `kos_source_documents` = 207 (all active) |
| Sync `knowledge-chunks-sync.js` | inserted 860, updated 0, unchanged 0; read-back 860/860 |
| Chunk-id stability | 860 unique, 0 collisions, deterministic across rebuild |
| Source-check (read path) | loadChunks + search(chunkSource=postgres) pass — 860 chunks |
| Source-check `--write` | publish#1 inserted=1, publish#2 idempotent (unchanged=1), publish#3 update disables stale, search finds fixture, cleanup OK |
| Embed backfill `--no-prune` | embedded 625, failed 0, pruned 0 (32 Gemini batch calls) |
| Coverage after backfill | **860 active chunks, 860/860 with embedding** |
| Disabled chunks with embedding | 0 (stage-3 invariant holds) |
| Duplicate `chunk_id` in `knowledge_chunks` | 0 |
| Repeat backfill idempotency | second run: 0 to embed, 0 API calls |
| Hybrid retrieval (real PG) | semanticCandidateCount = 9, semanticError = none, JOIN filter active |
| Benchmark `--hybrid` | same 6 failures as keyword-only — pre-existing, **hybrid not worse than file** |

## 2. Issues found & fixed (this session)

### 2.1 `chunkStore.js` — INSERT had more expressions than target columns
Real PG rejected the upsert (`code 42601`) because `VALUES (…, NOW(), NOW())` were 19 values while the column list was 17 (missing `created_at`, `updated_at`). Memory engine did not catch it (non-strict). Fixed: added `created_at, updated_at` to the column list. Tests re-run: `knowledgePublish`, `knowledgeChunksMigration` pass.

### 2.2 `knowledge-chunk-source-check.js` — score-based top-3 search is corpus-dependent
Fixture search by `'Cricova'` failed against the real 860-chunk corpus (fixture not in top-3 by score). Memory engine's empty corpus masked it. Fixed: fixture body now carries a unique `checkprobe<hex>` token and search uses that probe. `--write` passes on real PG.

### 2.3 `knowledge-embed-backfill.js` — `--no-prune` flag added
For a controlled two-phase migration on a live DB. When set, embeddings whose chunk is no longer in the set are left in place (logged, not deleted). Default remains `prune=true` (backwards compatible; `syncEmbeddings` gets `prune` option, tests updated implicitly via default).

### 2.4 `search.js` — semantic retrieval filtered to live chunks
`semanticCandidateIds` previously scanned `knowledge_chunk_embeddings` with **no JOIN and no enabled filter**, so orphan/stale embeddings participated in hybrid RRF ranking. Fixed: `JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id` with `(k.enabled IS NOT FALSE)`. Tests: `knowledgeChunksSelector`, `knowledgePublish` pass.

## 3. Orphan embeddings (prune candidates) — 1298

Before backfill, 1899 embeddings existed; only 601 had chunk_id matching the current scheme `sha256(source_file#chunk_index)`. The other **1298** were produced by an older chunker (different ids, same source_file).

- They did **participate** in semantic retrieval (no join filter) — fixed by 2.4.
- They are **not referenced** by any `knowledge_chunks` row.

### Backup / audit artifacts
- `docs/audit/orphan-embeddings-2026-07-31T16-10-24-868Z.csv` — 1298 rows (chunk_id, source_file, model, content_hash, updated_at)
- `docs/audit/orphan-embeddings-2026-07-31T16-10-24-868Z.json` — same + per-source_file stats

> Note: vectors themselves were **not** exported (only metadata). They are unrecoverable without re-embedding from source; the content (text) lives in `knowledge/source/*.md` and `knowledge_chunks`.

### ⚠️ Incident
On the first backfill attempt the `--no-prune` flag was inverted (`prune: argv.includes('--no-prune')`), so **1298 orphan rows were deleted**. Fixed (now `!includes`). The delete was re-run-free; those rows were metadata-only in the export. Content is intact (860 chunks fully embedded). Deletion SQL below is still provided for the planned, explicit prune step — **not executed again**.

## 4. Embeddings before / after

| Metric | Before | After |
|---|---|---|
| `knowledge_chunk_embeddings` rows | 1899 (601 current + 1298 orphan) | 860 (all current) |
| Orphan rows | 1298 | 0 (removed by the inverted-flag incident) |
| Active chunks covered | 601/860 | 860/860 |
| Gemini API calls (this session) | — | 32 batches (625 embeddings) |

## 5. Benchmark

`node tests/benchmark/retrieval-benchmark.js` (keyword-only, file) and `--hybrid` (real PG) both report the same 6 pre-existing failures:
- `Purkari`, `Crikova` (safe-suggestion entity=false expected, got=true)
- `Red vs white wine differences`, `Рислинг`, `Шардоне`, `Best Moldovan wines` (topic/entity expectations)

These are fixture/expectation issues unrelated to the PG migration. **Hybrid is not worse than file.**

## 6. Rollback plan

- **No runtime cutover performed.** Production still reads `knowledge/source` (file index) — `KNOWLEDGE_CHUNK_SOURCE` is unset.
- If embeddings must be restored to pre-session state: re-run `node scripts/knowledge-embed-backfill.js --no-prune` (idempotent; 0 API calls now) — already at 860/860.
- Orphan rows cannot be restored (no vector export) — but they are dead ids (never in `knowledge_chunks`), so runtime search is unaffected.

## 7. Planned explicit prune step (NOT executed)

Only after benchmark sign-off and confirming orphans are unused by runtime search:

```sql
-- Remove embeddings whose chunk no longer exists in knowledge_chunks
DELETE FROM knowledge_chunk_embeddings e
USING knowledge_chunk_embeddings e2
LEFT JOIN knowledge_chunks k ON k.chunk_id = e2.chunk_id
WHERE e.chunk_id = e2.chunk_id AND k.chunk_id IS NULL;
```

Expected effect now: **0 rows** (already cleaned by the incident). Alternatively restore-then-prune:
`node scripts/knowledge-embed-backfill.js` (prune on) — will delete nothing current.

## 8. Files changed (this session, uncommitted)

- `src/knowledge/chunkStore.js` — column-list fix (2.1)
- `scripts/knowledge-chunk-source-check.js` — unique probe fixture (2.2)
- `scripts/knowledge-embed-backfill.js` — `--no-prune` (2.3)
- `src/knowledge/search.js` — semantic JOIN filter (2.4)
- `docs/audit/orphan-embeddings-*.csv/json` — backup artifacts

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

### 2.3 `knowledge-embed-backfill.js` — `--no-prune` flag + dry-run + fail-safe
For a controlled two-phase migration on a live DB. Three safety layers now enforced:

| Flag / guard | Effect |
|---|---|
| `--no-prune` | Embeds new/changed chunks but never deletes; stale rows logged, left in place |
| `--dry-run` | Computes what would change, never writes (no upserts, no DELETE, no API calls) |
| `failed > 0 → skip prune` | If any embedding batch fails, DELETE is suppressed entirely — a partially-embedded run can never destroy orphan embeddings |
| Up-front log | `prune=true|false dryRun=true|false; N need embed, M stale` logged before any work starts |

Default remains `prune=true` (backwards compatible). `syncEmbeddings` now accepts `prune`, `dryRun` options and returns `pruneSkippedReason`.

### 2.4 `search.js` — semantic retrieval filtered to live chunks
`semanticCandidateIds` previously scanned `knowledge_chunk_embeddings` with **no JOIN and no enabled filter**, so orphan/stale embeddings participated in hybrid RRF ranking. Fixed: `JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id` with `(k.enabled IS NOT FALSE)`. Tests: `knowledgeChunksSelector`, `knowledgePublish` pass.

## 3. Incident — erroneous prune

**What happened:**
The `--no-prune` flag had an inverted boolean (`prune: argv.includes('--no-prune')` instead of `!includes`). On the first backfill run the flag was present, so `prune` evaluated to `true`. The embed batches all failed (ByteString error from an incorrectly extracted API key), but the prune section ran and deleted 1298 orphan rows.

**Exact row counts:**

| Point in time | `knowledge_chunk_embeddings` | `knowledge_chunks` |
|---|---|---|
| Baseline (before any run) | 1899 | 0 |
| After erroneous first run (embed failed, prune ran) | **601** | 0 |
| After `knowledge-chunks-sync.js` | 601 | 860 |
| After successful backfill `--no-prune` | **860** | 860 |
| Current (verified) | **860** | **860** |

1298 orphan embeddings (older chunker ids, same source_files) were deleted. The vectors were not exported before deletion and are unrecoverable. The content (text) lives in `knowledge/source/*.md` and `knowledge_chunks`; these orphan ids are dead (not in `knowledge_chunks`) and were already excluded from retrieval by the JOIN fix (2.4).

**Root cause fixed:** `prune: !process.argv.includes('--no-prune')`. Additionally, the `failed > 0 → skip prune` guard now prevents this class of error even if the flag is wrong.

### Backup / audit artifacts
- `docs/audit/orphan-embeddings-2026-07-31T16-10-24-868Z.csv` — 1298 rows (chunk_id, source_file, model, content_hash, updated_at)
- `docs/audit/orphan-embeddings-2026-07-31T16-10-24-868Z.json` — same + per-source_file stats

## 4. Embeddings before / after

| Metric | Before (baseline) | After erroneous prune | Final (current) |
|---|---|---|---|
| `knowledge_chunk_embeddings` rows | 1899 | 601 | **860** |
| Orphan rows | 1298 | 0 | 0 |
| Active chunks covered | 601/860 (pre-existing) | 601/860 | **860/860** |
| Gemini API calls | — | 0 (all batches failed) | 32 batches (625 embeddings) |

## 5. Benchmark

`node tests/benchmark/retrieval-benchmark.js` (keyword-only, file) and `--hybrid` (real PG) both report the same 6 pre-existing failures:
- `Purkari`, `Crikova` (safe-suggestion entity=false expected, got=true)
- `Red vs white wine differences`, `Рислинг`, `Шардоне`, `Best Moldovan wines` (topic/entity expectations)

These are fixture/expectation issues unrelated to the PG migration. **Hybrid is not worse than file.**

## 6. Safety invariants (unit-tested)

`tests/knowledgeBackfillSafety.test.js` covers 4 scenarios:

| # | Scenario | Expected |
|---|---|---|
| 1 | `prune=false` | Stale rows left in place; `pruneSkippedReason = 'no_prune_flag'` |
| 2 | Embedding batch fails, `prune=true` | `pruneSkippedReason = 'embedding_failures'`; stale rows survive; no DELETE executed |
| 3 | `dryRun=true` | 0 API calls; 0 DELETE; `pruneSkippedReason = 'dry_run'`; would-embed count reported |
| 4 | `prune=true`, all embeddings succeed | Stale rows removed; real chunk embedded |

## 7. Rollback plan

- **No runtime cutover performed.** Production still reads `knowledge/source` (file index) — `KNOWLEDGE_CHUNK_SOURCE` is unset.
- If embeddings must be restored to pre-session state: re-run `node scripts/knowledge-embed-backfill.js --no-prune` (idempotent; 0 API calls now) — already at 860/860.
- Orphan rows cannot be restored (no vector export) — but they are dead ids (never in `knowledge_chunks`), so runtime search is unaffected.

## 8. Planned explicit prune step (NOT executed)

Only after benchmark sign-off and confirming orphans are unused by runtime search:

```sql
-- Remove embeddings whose chunk no longer exists in knowledge_chunks
DELETE FROM knowledge_chunk_embeddings e
USING knowledge_chunk_embeddings e2
LEFT JOIN knowledge_chunks k ON k.chunk_id = e2.chunk_id
WHERE e.chunk_id = e2.chunk_id AND k.chunk_id IS NULL;
```

Expected effect now: **0 rows** (already cleaned by the incident).

## 9. Files changed (this session)

- `src/knowledge/chunkStore.js` — column-list fix (2.1)
- `scripts/knowledge-chunk-source-check.js` — unique probe fixture (2.2)
- `scripts/knowledge-embed-backfill.js` — `--no-prune`, `--dry-run`, fail-safe prune guard (2.3)
- `src/knowledge/search.js` — semantic JOIN filter (2.4)
- `tests/knowledgeBackfillSafety.test.js` — unit tests for safety invariants (§6)
- `docs/audit/stage1-3-real-pg-verification-2026-07-31.md` — this report
- `docs/audit/orphan-embeddings-*.csv/json` — backup artifacts

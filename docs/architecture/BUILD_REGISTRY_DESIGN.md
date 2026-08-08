# WINE AI — Build Registry Design (Phase 0B Step 2)

Status: design only — accepted as input for the next task. No runtime code, schema, migration, production write, deploy, or PR yet.
Branch: `phase0b/build-registry-design`
Date: 2026-08-04
Base: `origin/main` @ `3d0fb48` (corpus-manifest Step 1 merged)

> **Implementation note (PR #20, Draft):** the Registry Foundation in `src/buildRegistry/registry.js` now implements the contracts in §4.3–§4.6, §6.1, §7.1–§7.2, and §9. §4.4/§4.5/§4.6, §6.1, §7.1–§7.2 and the PR-1 acceptance criteria were updated to match the proven behavior (missing-pointer error, atomic strict init, single-active partial unique index, validated rollback with `previous_build` reset-to-legacy, repeated-activation contract). Verified against real PostgreSQL (`tests/buildRegistry.postgres.integration.test.js`, 61 assertions) and by the unit suite (`tests/buildRegistryFoundation.test.js`). PR #20 stays Draft — no merge, no deploy, no production write.

Predecessor audit: `docs/audits/corpus-manifest/report.md` + `manifest.json` (canonical input set, 453 included / 36 excluded, 9 duplicate groups).

---

## 1. Goal

Enable a **versioned, reproducible rebuild of the wine-knowledge corpus** with:

- a source-state snapshot that is deterministic and reusable (same input → same build id);
- atomic cutover between the legacy corpus and a new v2 build with **one-row rollback**, no redeploy of runtime code;
- a registry that records input provenance, chunk/embedding artifacts, hashes, and build status/history;
- idempotent, dry-run, and resume-safe build lifecycle;
- explicit verification gates before any build may be activated.

The registry is the authority for *what was built, from what, and whether it may serve production*.

---

## 2. Scope and initial tree

All work lives in the **clean worktree** below. The old folder `D:\AI\wine-ai-realtime` keeps its untracked temp/diagnostic/benchmark files; they are **not** moved here and **not** proposed for this PR.

- Worktree: `D:\AI\wine-ai-realtime-build-registry` (new, sparse-checkout excludes the pathological `.agents\rules\wine-ai-efficiency.md` path that Windows cannot check out — see §7).
- Branch: `phase0b/build-registry-design` at `origin/main` (`3d0fb48`), clean (no extra commits; working tree clean; `git diff origin/main...HEAD` empty).

### Temporary files that remain only in the old folder (not in this worktree)
`benchmark-results-2026-08-01.txt`, `benchmark-results-clean.json`, `grok_run2.txt`, `grok_run3.txt`, `grok_tap.txt`, `reconcile-production.json` (production snapshot — never committed), and the UNTRACKED diagnostic scripts: `check-*.js`, `debug-benchmark.js`, `explain-chunks.js`, `final-verification.js`, `migrate-normalize-crawled.js`, `normalize-*.js`, `parse-benchmark*.js`, `pre-cutover-audit*.js`, `publish-all-unpublished.js`, `publish-crawled.js`, `snapshot.js`, `snapshot-production-readonly.js`, `test-crawled-retrieval*.js`, `verify-final.js`, `verify-publish.js`, `embed-missing.js`, `rebuild-reconcile.js`.

### Tracking note — scripts proposed for the future PR
`corpus-manifest-audit.js` is **already tracked** at `3d0fb48` and produced `docs/audits/corpus-manifest/*` (also tracked). The build scripts below are **design-only proposals**; **none are written yet**, and only a subset is intended for the eventual implementation PR.

| Proposed script (future PR) | Purpose | Promote to PR? |
| --- | --- | --- |
| `scripts/build-registry.js` | Create build, compute input snapshot + hashes, orchestrate stages | Yes (core) |
| `scripts/build-versioned-corpus.js` | Materialize v2 chunks + embeddings inside a build transaction | Yes (core) |
| `scripts/build-dry-run.js` | Read-only build simulation, no schema/writes | Yes (shared with core) |
| `scripts/build-verify.js` | Post-build verification gates (§6) | Yes (core) |
| `scripts/build-registry-readonly-audit.js` | Registry read-only audit/diff of registered builds | Yes (ops) |
| `scripts/snapshot-production-readonly.js` | Read-only production snapshot for design | **No** (temp; keep local only) |
| `scripts/rebuild-reconcile.js` | Regenerate `reconcile-production.json` from live DB | **No** (temp; `reconcile-production.json` is a production snapshot, untracked) |
| `scripts/pre-cutover-audit*.js`, `check-*.js`, `explain-chunks.js`, `embed-missing.js`, `final-verification.js`, `verify-*.js`, `publish-*.js`, `parse-benchmark*.js`, `normalize-*.js`, `migrate-*.js`, `debug-benchmark.js` | One-off diagnostics/writes | **No** (never proposed; keep local or drop) |

Nothing in this worktree references, prints, or stores the connection string or any secret. The production snapshot lives only in the old folder and is untracked.

---

## 3. Canonical input policy and versioning rules

### 3.1 Canonical inputs (the ONLY versioned-build inputs)
Derived from `docs/audits/corpus-manifest/report.md`:

| Input | Include rule | Observed count |
| --- | --- | --- |
| `kos_source_documents` | `status='active'` AND non-empty `normalized_text` | 182 of 216 |
| `knowledge_documents` | `status='approved'` AND non-empty `text` | 242 of 242 |
| git-committed curated `.md` files | non-empty body, non-`demo` confidence, external provenance source | 29 of 31 |
| `index.json` | **never** an input (derived, regenerated at boot) | — |

### 3.2 Explicit exclusions (with reasons)
- **All `discovered-*` derived rows** (filesystem-derived KOS republish output): generated, not canonical — always excluded as inputs (the audit's `discovered-kos-*` overlap / 257 duplicate PG chunks are legacy artifacts and must never be v2 inputs, §5 gate).
- **`unavailable` / non-served content**: any row whose `status` is not `active`/`approved` (fail, pending, archived, or missing `normalized_text`/`text`) is excluded — unavailable = no canonical input.
- **Navigation-only / boilerplate content**: content that is only nav chrome (menus, footers, "back to top"), empty, or JS-rendered (title comes from a placeholder but body is script) has no extractable semantic text and is excluded. Operationalized as: no `normalized_text`, or de-SSR'd body that is `navBoilerplate`/JS-rendered per the Step 1 audit (25 + JS-rendered set).
- `curated-demo` (2): demo content — excluded by policy.
- `index.json`: derived artifact, not input.
- 2 unlinkable legacy PG chunks: no canonical input → **dropped in v2**.
- 1302 orphan embeddings in `knowledge_chunk_embeddings`: legacy data, **not migrated** to v2.
- The 9 duplicate groups (24 KOS docs: 8 kos-kos + 1 kos-disc): MUST be resolved by the named **dedupe policy** (§3.4) in the build; unresolved duplicates are a hard gate (§3.4/§6.4).

Collated canonical input set: **453 included / 36 excluded** (per manifest), all exclusions pinned with a reason in `input_snapshot`.

### 3.3 Source versioning policy (unambiguous)
- **`stable_id`** = semantic identity: `sha256(source_file#document)`. Two documents with the same `stable_id` are the *same* logical document; a changed body is a new *version*, not a new document.
- **`version_key`** = content version: `sha256(normalized_text/text + normalized metadata)` for DB rows, or the file's body hash for curated `.md`. Computed per canonical input at scan time.
- **Coalescing rule:** input is *new* (upsert) when either no `stable_id` row exists for the build OR `version_key` differs from the build's recorded one; identical `stable_id`+`version_key` → unchanged (skipped). This is the deterministic "same input → same build_id, same chunk hashes" guarantee.
- The registry stores, per included input: `source_kind`, `stable_id`, `version_key`, `source_ref`, `content_hash`, `included`, and (for the 36 excluded) `excluded_reason`, once in the input snapshot as an audit trail.

### 3.4 Dedupe policy (applied inside the build; a hard gate, not a manual pre-step)
Recorded unambiguously and **enforced by the build's include filter** — the build refuses to start while any duplicate group is unresolved at scan time:

1. **8 kos-kos duplicate groups** (identical `normalized_text` across `kos_source_documents`): keep the row with the earliest `created_at` and the **best** (most specific) `canonical_url`/title; mark all others `duplicate_of=<kept stableId>` and exclude them. Tie-break: keep the lowest stableId (stable ordering).
2. **1 kos-disc duplicate group**: keep the `kos_source_documents` canonical row; drop the `discovered-*` derived row (no canonical input).
3. All decisions are recorded in the build input snapshot (`dedup: [{kept, collapsed:[]}]`) and are reproducible; the dedup map is verified in gate §6.4‑4.
4. A duplicate group that appears at scan time but is **not** covered by a named rule → the build exits with `verification_failed`/abort; it never silently guesses.

---

## 4. Exact DDL (new, additive tables)

Schema follows the existing `src/knowledge/db.js` (knowledge) and `src/kos/db/kosSchema.js` (KOS) conventions: `CREATE TABLE IF NOT EXISTS`, additive `ADD COLUMN IF NOT EXISTS`, explicit indexes, `NOW()` defaults, `kos_set_updated_at()` trigger helper where relevant. All new tables are **additive** — they never alter legacy tables.

**Schema migration owner — confirmed, NOT auto-KOS-v8.** The registry is a *knowledge/corpus* concern, not a KOS (winery/entity knowledge) concern. KOS migrations are checksum-versioned and semantically owned by the winery/entity domain (`kos_schema_migrations`, `kosSchema.js:696-761`); bolting the corpus registry onto them would couple two unrelated domains and put registry DDL under KOS's drift-check. The correct owner is a dedicated **build-registry module** (`src/buildRegistry/`) using the same additive, idempotent `CREATE TABLE IF NOT EXISTS` pattern as `src/knowledge/db.js:init()`. The registry schema is a single self-contained, idempotent block — no new migration-tracking table needed, and it is deliberately kept out of `kos_schema_migrations` (no `v8` entry).

**Embedding dimension is taken from the actual production schema, not hardcoded:** the registry's vector column must match `knowledge_chunk_embeddings.embedding` (`vector(768)`, verified at `src/knowledge/db.js:98`; runtime default `EMBEDDING_DIMENSIONS = 768` at `src/knowledge/embeddings.js:10`; model `gemini-embedding-001`). The build script reads the dimension via an introspection query (`SELECT atttypmod ...` on the legacy embedding column) and refuses to run if it disagrees with the configured model output. **No `vector(1536)` is or should be used.**

> These are the exact columns that mirror the existing legacy shapes so `search()` can consume v2 chunks without format conversion (same seam as `loadChunksFromPostgres` in `src/knowledge/chunkStore.js`).

### 4.1 `build_registry_builds` — one row per build attempt

```sql
CREATE TABLE IF NOT EXISTS build_registry_builds (
    build_id            TEXT PRIMARY KEY,          -- deterministic: sha256(input fingerprint) slice16
    status              TEXT NOT NULL CHECK (status IN (
                            'building','ready','active','rolled_back',
                            'verification_failed','cancelled')),
    -- input fingerprint pins the exact corpus version
    input_fingerprint   TEXT NOT NULL,
    input_snapshot      JSONB NOT NULL,            -- full canonical input set + exclusions + dedup
    source_count        INT  NOT NULL,
    chunk_count         INT  NOT NULL DEFAULT 0,
    embedding_count     INT  NOT NULL DEFAULT 0,
    model               TEXT,                      -- e.g. gemini-embedding-001
    hooks_version       TEXT,                      -- deterministic chunk/hash version, e.g. v1
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at         TIMESTAMPTZ,
    created_by          TEXT,                      -- operator label, optional
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_build_registry_builds_status ON build_registry_builds(status);
CREATE INDEX IF NOT EXISTS idx_build_registry_builds_fingerprint ON build_registry_builds(input_fingerprint);
```

### 4.2 `build_registry_chunks` — v2 chunk artifacts AND their embeddings (self-contained per build)

```sql
CREATE TABLE IF NOT EXISTS build_registry_chunks (
    chunk_id        TEXT NOT NULL,                 -- sha256(source_file#chunk_index); NOT globally unique
    build_id        TEXT NOT NULL REFERENCES build_registry_builds(build_id) ON DELETE RESTRICT,
    source_file     TEXT NOT NULL,
    title           TEXT,
    doc_type        TEXT,
    language        TEXT,
    source          TEXT,
    confidence      TEXT,
    entity_id       TEXT,
    winery          TEXT,
    region          TEXT,
    grape           TEXT,
    date            TEXT,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    chunk_index     INT NOT NULL DEFAULT 0,
    text            TEXT NOT NULL,
    content_hash    TEXT NOT NULL,                 -- computeChunkHash v1
    version_key     TEXT NOT NULL,                 -- source content version
    embedding       vector(768),                   -- NULL = not yet embedded (same rule as legacy)
    model           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (build_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_build ON build_registry_chunks(build_id);
CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_source ON build_registry_chunks(build_id, source_file);
-- vector index for nearest-neighbour (legacy uses ivfflat lists=100; keep the same trade-off for parity)
CREATE INDEX IF NOT EXISTS idx_build_registry_chunks_vector
    ON build_registry_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Notes:
- Embeddings are **in the same row** as chunk text (unlike legacy's separate `knowledge_chunk_embeddings`). This avoids the legacy orphan-embedding failure mode by construction and lets a build claim chunk+embedding atomically.
- `chunk_id` intentionally **collides with** legacy `knowledge_chunks.chunk_id` scheme, but is **not** globally unique: the PK is the composite `(build_id, chunk_id)`. This is what lets multiple builds (each an independent corpus over the same source files) coexist without row collision. The same `chunk_id` may appear under several `build_id`s; each build's chunks are addressed strictly by `WHERE build_id = $1`.
- Upsert (resume/idempotency) uses `ON CONFLICT (build_id, chunk_id) DO UPDATE`. A build never mutates another build's rows because conflict resolution is scoped to the same `build_id`.
- **`build_id` FK is `ON DELETE RESTRICT` (not CASCADE):** a build that owns any chunk row cannot be deleted, so **orphan chunks are impossible** — you can neither delete a build out from under its chunks nor insert a chunk whose `build_id` doesn't already exist. Deleting a build requires first deleting its chunks explicitly (and only after it is no longer `active`), which is an explicit operator action. This replaces the earlier CASCADE proposal.

### 4.3 `build_registry_state` — the live pointer (cutover authority)

```sql
CREATE TABLE IF NOT EXISTS build_registry_state (
    key             TEXT PRIMARY KEY,              -- 'active_build' | 'previous_build'
    value           TEXT,                          -- 'legacy' or a build_id
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **On schema init the pointer rows are seeded idempotently:** `active_build='legacy'`, `previous_build='legacy'` (idempotent `INSERT ... ON CONFLICT DO NOTHING`). A fresh DB therefore defaults to the legacy path and never fails a pointer read.
- **Both pointer rows always exist.** Init creates both rows (`ON CONFLICT DO NOTHING` re-creates a row if one is ever missing), and rollback **resets** `previous_build` to `legacy` instead of deleting the row — the row set is never emptied. This makes the two-row read model stable and removes the old `DELETE ... WHERE key='previous_build'` failure mode (a missing row previously made a second rollback impossible).
- **Write ops require both rows; no silent fallback.** `activateBuild` and `rollbackBuild` read both pointer rows *after* taking the row lock and require them to exist: a missing `active_build` row throws `MISSING_ACTIVE_BUILD`, a missing `previous_build` row throws `MISSING_PREVIOUS_BUILD` — **before any `UPDATE`**, so pointer and build statuses stay untouched (zero mutation, verified in unit + real-PG tests). A missing row is corruption and is surfaced, never silently treated as `legacy` inside a write path.
- Parity with existing `app_settings` (`src/knowledge/searchMode.js`) is intentional: same persisted-toggle pattern that survives `railway up`, but a dedicated table keeps the pointer distinct from search-mode. `active_build = 'legacy'` reproduces today's behavior exactly.

### 4.4 Pointer read (runtime, per-request)

```sql
SELECT value FROM build_registry_state WHERE key = 'active_build';
```

- `legacy` → current path (keyword FS `index.json`; semantic → `knowledge_chunk_embeddings` JOIN `knowledge_chunks`).
- `<build_id>` → v2 path (keyword + semantic → `build_registry_chunks` WHERE `build_id = $1`).
- Cutover **and** rollback = the atomic pointer transactions in §7. No deploy.

**Missing / non-existent active build is an explicit error, not a silent fallback.** `resolveActiveBuild()` returns one of:
- `{ build_id: 'legacy' }` — safe default (legacy), returned only when the pointer value is literally `'legacy'`.
- `{ build_id: '<id>' }` — a *verified* build whose `status='active'` and which exists in `build_registry_builds`.
- `{ error: 'MISSING_ACTIVE_BUILD' }` — the `active_build` pointer row itself is absent.
- `{ error: 'INVALID_ACTIVE_BUILD', build_id }` — the pointer references a build_id that does **not** exist in `build_registry_builds`, or exists but is **not** `status='active'`.

`activateBuild`/`rollbackBuild` use the same structured errors (`MISSING_ACTIVE_BUILD`, plus `MISSING_PREVIOUS_BUILD` for a missing `previous_build` row) as thrown errors before any write (§4.3).

Rule: **no production fallback that hides a corrupt pointer.** If the pointer row is missing or the pointer is dangling/points at a non-active build, `resolveActiveBuild()` never silently returns `legacy`; it returns the explicit error so the corruption is surfaced (logged/monitored), not papered over. A valid build is only reported when it is present and `active`.

### 4.5 Schema init is atomic (one client, one transaction)

`initSchema(pool)` runs the entire schema block on **one** client in **one** transaction: `BEGIN → FULL_INIT → seed both pointer rows → COMMIT`.

- `FULL_INIT` is a single ordered statement list: `CREATE EXTENSION IF NOT EXISTS vector`, `build_registry_builds`, `build_registry_chunks`, `build_registry_state`, the single-active unique index, the supporting indexes, `ALTER TABLE ... ADD COLUMN embedding vector(768)`, and the `ivfflat (vector_cosine_ops, lists=100)` index.
- If **any** statement fails (including the pgvector-dependent ones), the whole init `ROLLBACK`s and the error is rethrown — **no partial schema is ever counted as success**. Verified by failure-injection: an injected error mid-DDL leaves **zero** registry objects.
- If pgvector is unavailable, `CREATE EXTENSION IF NOT EXISTS vector` itself fails (SQLSTATE `0A000` `feature_not_supported` / `42704`), so init aborts cleanly with zero objects — strict by design, never a half-created schema.
- Idempotent: every statement is `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, so re-running init is a no-op after the first success.

### 4.6 Single-active DB invariant

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_build_registry_builds_single_active
    ON build_registry_builds (status) WHERE status = 'active';
```

A **partial unique index** enforces "exactly one `active` build" at the database level, so even a buggy caller can never leave two builds `active`. A second `active` row raises `23505` (`unique_violation`), verified against real PostgreSQL and via the activation transaction's demote-before-promote ordering. The pointer (`active_build`) and the status are therefore kept consistent by both application logic (§7.1) and a hard DB constraint.

---

## 5. Legacy vs v2 read paths (SQL + function level)

### 5.1 Today (legacy, unchanged)
- Keyword: `loadIndex('/index.json')` → `index.chunks` (`src/knowledge/search.js:117-149`).
- Semantic (`semanticCandidateIds`, `src/knowledge/search.js:153-172`):

```sql
SELECT e.chunk_id, e.embedding <=> $1 AS distance
FROM knowledge_chunk_embeddings e
JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id
WHERE e.embedding IS NOT NULL
  AND (k.enabled IS NOT FALSE)
  AND e.embedding <=> $1 < $3
ORDER BY e.embedding <=> $1
LIMIT $2;
```

### 5.2 v2 read path (same `search()` seam, different table/filter)
- Keyword candidates: `SELECT ... FROM build_registry_chunks WHERE build_id = $1 AND enabled` (loaded through the same `_indexFromChunks` shape `search.js:412-415`).
- Semantic (`semanticCandidateIdsForBuild`):

```sql
-- fn semantics: ($1 vector, $2 limit, $3 max_dist, $4 build_id)
SELECT c.chunk_id, c.embedding <=> $1 AS distance
FROM build_registry_chunks c
WHERE c.build_id = $4
  AND c.embedding IS NOT NULL
  AND c.enabled IS NOT FALSE
  AND c.embedding <=> $1 < $3
ORDER BY c.embedding <=> $1
LIMIT $2;
```

- Parameter shape mirrors legacy `semanticCandidateIds` (`$1` vector, `$2` limit, `$3` max distance), with `build_id` appended as `$4`; `SEMANTIC_MAX_DISTANCE = 0.6` (same as `search.js:151`). This keeps the vector-search clause structurally identical to the legacy query (§5.1) so the index strategy (`ivfflat lists=100`, `vector_cosine_ops`) and tuning carry over.

- **Function seam (proposed):** a single resolver `resolveActiveBuild(pool)` returns `{build_id:'legacy'|...}` from §4.4; `search()` branches on it **before** choosing the chunk source. Everything downstream (`keywordSearch`, `entityHits`, `aliasTextSearch`, `semanticCandidateIds`, RRF in `search.js:174-183`) is unchanged because it operates on the in-memory chunk array shape.

---

## 6. Build lifecycle: dry-run, resume, idempotency, verification gates

### 6.1 Lifecycle states (minimal proven set)

`building → ready → active → rolled_back`

Recorded 1:1 in `build_registry_builds.status` (CHECK clause above) and mirrored by the `build_registry_state` pointer where relevant. Explicit, operator/script-driven transitions only — **no timer/heuristic transitions** (per `INVARIANTS.md`). No transient state is persisted (a former `verifying` state is deliberately absent: verification is a synchronous pass, not a stored transition).

| Status | Meaning | Entered by | Exit to |
| --- | --- | --- | --- |
| `building` | chunk+embedding stages in progress | build script upsert (PR2) | `ready` (on success) / `cancelled` / `verification_failed` |
| `ready` | artifacts complete, passed verification gates (§6.4), awaiting explicit activation | verification pass | `active` (activation) |
| `active` | the served corpus; pointer `active_build = <this build_id>` | explicit activation transaction (§7.1) | `ready` (superseded by a newer activation) or `rolled_back` (rollback) |
| `rolled_back` | was active, superseded via rollback (§7.2) | rollback transaction | `ready` via committed re-verify (§6.3a); it never auto-returns to `active` — activation is always an explicit transaction |
| `verification_failed` / `cancelled` | terminal, never activatable | gate failure / operator | — |

Key invariant: **exactly one build has `status='active'` at any time, and it is always the build referenced by `active_build`.** This is enforced twice: (1) by the activation transaction, which demotes the currently-served build to `ready` in the same transaction before promoting the new build; and (2) by the partial unique index `uq_build_registry_builds_single_active` (§4.6), which makes a second `active` row a DB-level `23505`. Both the pointer flip and every status change are atomic in the activation transaction.

### 6.2 Dry-run
- `build-dry-run.js` performs the full input scan, dedupe application, chunk estimation, and hash computation **read-only** — no table writes, no embedding API calls.
- Output: `input_fingerprint`, source counts, estimated chunk count, target `build_id` (deterministic), and the verification checklist that a real run would apply.

### 6.3 Resume & idempotency
- `build_id` is deterministic from the input fingerprint, so re-running the **same input** lands on the **same build row**.
- Every stage upserts (`ON CONFLICT`) rather than blind-inserts; re-running only changes rows whose `content_hash` differs (same pattern as `importChunksToPostgres` in `chunkStore.js:152`).
- A build that stopped mid-flight resumes from its recorded `status`: unchanged chunks/embeddings are skipped, only missing/changed ones are (re)processed. Embedding calls are skipped for rows where `embedding IS NOT NULL` (idempotent).

### 6.3a Committed re-verify (`verifyCommittedBuild`) — resume semantics for an already-materialized build
- `runBuild --resume` re-fetches every source and re-checks the live DB against the canonical pin. That is correct for **new materialization**, but must NOT be the way we re-verify an *already committed* build: once a build's chunks/embeddings are materialized and verified, its only source of truth is the **stored `input_snapshot` + committed `build_registry_chunks` rows**, not the live DB.
- `builder.verifyCommittedBuild(pool, buildId)` (CLI: `--verify-committed <id>`) re-certifies a **committed** build from its own committed state: it reads the stored snapshot, recomputes the deterministic fingerprint (must match the stored one), and re-runs the DB-checkable gates (counts, chunk determinism, embedding coverage, input pin, no contamination) **without re-fetching live sources and without re-embedding**. On pass it sets status `ready`; on a tampered/gate failure it throws `VERIFICATION_FAILED`.
- **Live drift does not mutate an immutable build.** A source that changed on disk/postgres after materialization only changes the identity of a **future** build (new `version_key` → new fingerprint → new `build_id`). The committed snapshot keeps its own pinned content, provenance and `build_id` untouched.
- This makes the re-activation path `rolled_back → ready → active` possible at all: a previously-verified build can be restored to `ready` without depending on whether the live DB still matches a historic pin.

### 6.4 Verification gates (applied before a build may be marked `ready`; `verification_failed` blocks further promotion)

Every gate below must pass; a single failure sets `status='verification_failed'` (terminal) and the build can never become `active` without a fresh run.

1. **Counts:** registered `source_count`, `chunk_count`, `embedding_count` match the derived plans (included sources → chunks → embeddings). Any mismatch → fail. Deterministic so re-verification is reproducible.
2. **Chunk determinism:** every `chunk_id` and `content_hash` matches `sha256(source_file#index)` / `computeChunkHash v1` (reuse `verifyChunkIdStability`, `chunkStore.js:118`).
3. **Embedding coverage:** `embedding_count == chunk_count` for enabled chunks (0 missing), and **0 orphan embeddings** by construction (single-table design); **0 null embeddings** in an `enabled` chunk.
4. **Input pin:** registered `input_fingerprint` == hashes of included inputs; the 36 excluded + dedup map present in `input_snapshot`.
5. **No legacy contamination:** v2 build rows reference only canonical inputs; 1302 legacy orphan embeddings and the 2 unlinkable chunks are **absent** from the snapshot (they may still exist in legacy tables but must never appear in v2). Also asserts **no row in `build_registry_chunks` for this `build_id` references a legacy-only artifact**.
6. **Micro/macro correctness (code gates):** `npm run check:missing-imports`, `node --test tests/startupNoAdminAuth.test.js`, `npm test`, `npm run test:smoke` are green with the v2 read path wired; plus a targeted retrieval parity test comparing legacy vs v2 on the same query battery (identical top-k for canonical queries).
7. **Retrieval benchmark:** `npm run benchmark:retrieval` and `npm run benchmark:retrieval:hybrid` run against the v2 build; top-k results on the benchmark battery must be equal or better than legacy on recall, with no missing hits for canonical queries.
8. **Latency budget:** p95/p99 of `search()` under the v2 build must not regress beyond legacy by a stated bound (e.g. ≤ legacy p95 + 25%), measured with the same query battery and DB profile.
9. **Rollback test (staging):** an automated test activates the build (§7.1), serves queries, rolls back (§7.2), and asserts (a) legacy is restored, (b) no data is deleted, (c) pointer ended on `legacy`/`previous_build`, (d) the build's status is `rolled_back`. Must pass before the same build may be activated in production.
10. **Repeated-activation / second-rollback contract (staging):** an automated test runs `activate(A) → activate(B) → rollback` and asserts the immediate previous build (`A`) is restored as `active` with `previous_build` reset to `legacy`; a second `rollback` then restores `legacy`. This pins the rollback-of-a-rollback semantics (§7.2) so a repeated `activate → activate → rollback` cycle never restores the wrong build.

A build may be referenced by `active_build` **only** when its status is `active`; the pointer never references a `building`, `ready`, `rolled_back`, `verification_failed`, or `cancelled` build.

---

## 7. Cutover and rollback

Concurrency model: cutover and rollback are serialized by **row locking**. Both transactions begin by locking the pointer rows (`SELECT ... FOR UPDATE` on the `build_registry_state` rows being changed), so two concurrent activations (or an activation racing a rollback) cannot interleave — the second one blocks until the first commits, then reads the fresh pointer. There is exactly **one** writer per pointer at a time.

### 7.1 Activation (cutover) — active pointer transaction

```sql
BEGIN;
-- serialize concurrent cutovers: lock the two pointer rows
SELECT value FROM build_registry_state WHERE key IN ('active_build','previous_build') FOR UPDATE;
-- validate target is a real, ready-but-not-yet-active build
SELECT status FROM build_registry_builds WHERE build_id = '<build_id>' FOR UPDATE;
-- (throws BUILD_NOT_FOUND if missing, BUILD_NOT_READY if not status='ready')
SELECT value FROM build_registry_state WHERE key = 'active_build';  -- current = '<prev>'
-- demote the currently-served real build (if any) to 'ready'
UPDATE build_registry_builds SET status = 'ready', updated_at = NOW()
 WHERE build_id = '<prev>';
-- (throws INVALID_ACTIVE_BUILD if the current active row is missing — a corrupt pointer
--  is never silently demoted/replaced)
UPDATE build_registry_state SET value = '<prev>', updated_at = NOW()
 WHERE key = 'previous_build';
UPDATE build_registry_state SET value = '<build_id>', updated_at = NOW()
 WHERE key = 'active_build';
UPDATE build_registry_builds SET status = 'active', updated_at = NOW()
 WHERE build_id = '<build_id>';
COMMIT;
```

- Atomic: readers never observe a half-flip. If any statement fails, `ROLLBACK` leaves pointer and status untouched.
- Row-locking guarantees a concurrent activation blocks here and then targets the *new* `active_build`, so the last committer wins deterministically — no lost update, no interleaving. Verified against real PostgreSQL with two concurrent activations: both settle, one candidate ends `active`, the loser ends `ready`, and `previous_build` equals the loser.
- `active_build` therefore always equals a build whose status is `active` (or `legacy` sentinel before first cutover), and **exactly one real build is `active` at a time**: the superseded build is demoted to `ready` in the same transaction, and the partial unique index (§4.6) enforces it at the DB level.
- The prior served corpus is preserved in `previous_build` (never `DELETE`d during cutover), so rollback is always available.

### 7.2 Rollback — rollback transaction

```sql
BEGIN;
-- serialize with any in-flight cutover
SELECT value FROM build_registry_state WHERE key IN ('active_build','previous_build') FOR UPDATE;
SELECT value FROM build_registry_state WHERE key = 'active_build';  -- current
SELECT value FROM build_registry_state WHERE key = 'previous_build'; -- previous
-- validate the rollback target BEFORE touching anything
--  previous='legacy'            -> valid (restore legacy path)
--  previous row missing/ghost   -> throw INVALID_PREVIOUS_BUILD, abort, nothing changes
--  previous.status <> 'ready'   -> throw INVALID_PREVIOUS_BUILD, abort, nothing changes
IF previous <> 'legacy':
    SELECT status FROM build_registry_builds WHERE build_id = previous; -- must be 'ready'
IF current == 'legacy':
    COMMIT;  -- nothing to roll back; legacy is already served
-- mark the currently-served build as rolled back
UPDATE build_registry_builds SET status = 'rolled_back', updated_at = NOW()
 WHERE build_id = current;
UPDATE build_registry_state SET value = previous, updated_at = NOW()
 WHERE key = 'active_build';
IF previous <> 'legacy':
    UPDATE build_registry_builds SET status = 'active', updated_at = NOW()
     WHERE build_id = previous;
UPDATE build_registry_state SET value = 'legacy', updated_at = NOW()
 WHERE key = 'previous_build';   -- reset (not DELETE); the row always exists
COMMIT;
```

- Immediate, single transaction, no redeploy. The **legacy tables are never deleted** during this phase, so rollback to `legacy` (or to the recorded `previous_build`) is always possible.
- If `previous_build = 'legacy'`, rollback restores the legacy path exactly. If a prior v2 build was superseded, rollback restores that v2 build and flips its status back to `active` in the same transaction.
- **Rollback never deletes build rows or artifacts** — it only moves the pointer and status. `previous_build` is **reset to `'legacy'`** (not deleted), so the two pointer rows always exist and a repeated `activate → activate → rollback` cycle restores the immediate previous build on the first rollback and `legacy` on the second.
- **The rollback target is validated before any write.** If `previous_build` is missing/ghost or its build is not `status='ready'`, rollback aborts with `INVALID_PREVIOUS_BUILD` and leaves the pointer and statuses untouched — a corrupt `previous_build` can never make rollback silently point at a bad build.
- Row-locking makes rollback safe against a concurrent cutover: one of them wins, the other re-reads and acts on the post-commit pointer.

### 7.3 Cache invalidation strategy

`build_registry_state` is read per-request, but a runtime may cache chunk/embedding material in memory (mirroring the boot-built `index.json` today). To keep cutover/rollback effective without redeploy, invalidate any in-memory index/embedding cache on the same event that flips the pointer:

- **Detect at request time:** `resolveActiveBuild(pool)` reads `active_build` before choosing the chunk source; if it differs from the value the in-memory cache was built for, the cache is dropped and rebuilt for the new `build_id`. Compare by `build_id` (cheap equality), not by content, so a pointer flip is a cache miss, not a staleness bug.
- **No cross-build reuse:** a cached keyword index and cached vector results are keyed by `build_id`; a value built for build A is never served under build B (memory key = `build_id`).
- **Guarantee:** after the §7.1 commit, the next request both (a) sees the new `active_build` and (b) rebuilds in-memory structures for it — so cutover is atomic at the DB and effective at the cache on the next request. This is the same invalidation-on-read model the versioned runtime requires, and it introduces no new state machine.

### 7.4 Failure modes

| Failure | Detection | Behaviour | Recovery |
| --- | --- | --- | --- |
| Build fails mid-stage | `status` not `ready` | row kept as `verification_failed`/`cancelled`; never referenced | resume: re-run upsert; unchanged rows skipped |
| Activate target missing / not `ready` | resolution/validation throws | txn rolls back; pointer unchanged | retry with valid target |
| **Mid-transaction failure (failure-injection)** | statement throws after pointer write | txn `ROLLBACK` → pointer **and** status both unchanged, never desynced | retry; covered by automated failure-injection test (§9) |
| Activation txn partial | transaction rolls back | both pointer + status unchanged | retry activation |
| Rollback txn partial | transaction rolls back | pointer unchanged, legacy safe | retry rollback |
| Concurrent cutover/rollback | both `FOR UPDATE` on pointer rows | second blocks until first commits, then reads fresh pointer | automatic (row lock) |
| Pointer references missing/`non-active` build | resolver returns `INVALID_ACTIVE_BUILD` | **never** silent legacy fallback (no corruption hiding); surfaced/logged | operator repairs or voids the pointer |
| DB down (transient unavailability) | resolver throws before any read | distinguished from corruption: serves legacy + logs error | retry when DB returns |
| Cache serves stale build | `build_id` mismatch on read | treated as cache miss, rebuilt | automatic |

### 7.5 Safety rules
- Legacy pipeline `knowledge-chunks-sync.js` is **permanently stopped** and must not run during a v2 build (`report.md` blocker).
- v2 writes go only into `build_registry_*` tables inside a transaction (`BEGIN/COMMIT/ROLLBACK` via `pool.connect()`), mirroring the publish-path pattern. A failed build leaves `status='verification_failed'` or `'cancelled'` and is never activated.
- **No automatic activation.** A build reaches `ready` after verification but the pointer is flipped to `active` only by an explicit operator/script action (§7.1). Nothing in the build pipeline reads the pointer or promotes a build.

---

## 8. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Duplicate KOS groups unresolved (9 groups / 24 docs) | Build refuses to start (§3.4) | Named, enforced dedupe policy; build gate |
| Connection string / PAT leakage | Security | Not printed in this worktree's tooling; rotate exposed PAT + DB credential (MUST, pending) |
| Sparse-checkout workaround (`build_registry_*` created on Windows) | Working-tree fragility | Documented in §7; `.agents` excluded only in this worktree |
| Legacy orphan embeddings reused | Drift / wrong results | Single-table v2, orphan-free by construction; verification gate §6.4-3, §6.4-5 |
| `search()` chunk-source branching regression | Wrong retrieval | Reuse existing seam; parity test legacy vs v2 |
| Embedding API cost/rate on rebuild | Cost / time | Idempotent skip of non-NULL embeddings; resume support |

---

## 9. Implementation split: PR 1 = Registry Foundation, PR 2 = Build Pipeline

Confirmed senior decision: the versioned corpus lands in **two** PRs so the build pipeline sits on a proven foundation instead of building both at once.

### PR 1 — Registry Foundation (first implementation PR, minimal)

In scope:
- Additive registry schema: `build_registry_builds`, `build_registry_chunks`, `build_registry_state` (idempotent `CREATE TABLE IF NOT EXISTS`; owner = `src/buildRegistry/`, **not** KOS `kos_schema_migrations`).
- **Atomic schema init** (`initSchema`): one client, one transaction, strict `FULL_INIT` incl. `CREATE EXTENSION vector`, `embedding vector(768)` column, and the `ivfflat` index; any failure → full ROLLBACK, zero partial objects (§4.5).
- **Single-active DB invariant:** partial unique index `uq_build_registry_builds_single_active` (§4.6).
- `build_registry_chunks.build_id` FK with `ON DELETE RESTRICT` (orphan chunks impossible; see §4.2).
- Pointer helpers: `resolveActiveBuild(pool)` (§4.4 — incl. explicit `MISSING_ACTIVE_BUILD`) and the **cutover/rollback transactions** (§7.1/§7.2) with row locking (`SELECT ... FOR UPDATE`), previous-target validation, and `previous_build` reset-to-legacy (never deleted).
- Schema + unit tests (in-memory transactional double), including a **failure-injection test** proving pointer/status never desync on a mid-transaction failure (ROLLBACK leaves both untouched), concurrency/lock-serialization coverage, invalid-target rejection, orphan-chunk FK rejection, and the repeated `activate → activate → rollback` contract (gate §6.4-10).
- A **real-PostgreSQL integration test** (`TEST_DATABASE_URL`; skips cleanly when unset) that re-verifies every guarantee above against a live `pg` Pool, and a CI job that runs it against a PostgreSQL service (pgvector when available).

Out of scope for PR 1:
- Build corpus, chunks import, embeddings, benchmark — all in PR 2.
- Changing `src/knowledge/search.js` to consume `build_registry_*` (the v2 read path).
- Production migration, Railway variables, deploy, cutover, production writes.
- Knowledge Graph / Answer Audit / Wine Intelligence.

### PR 2 — Build Pipeline (subsequent, sits on PR 1)

- `build_dry_run.js`, `build_create.js`, `build_corpus.js`, `build_verify.js`, `build_registry_readonly_audit.js`.
- Deterministic `build_id`, `stable_id`, `version_key` computation; input snapshot + dedupe enforcement (§3.3/§3.4); chunk generation + embeddings; verification gates (§6.4); cache invalidation wiring (§7.3).

### Estimates
Mainly driven by embedding calls (~1.3k new chunks to embed for v2; most legacy rows carry no reusable embedding because v2 is a separate table).

| Item | Estimate |
| --- | --- |
| PR 1: DDL + pointer + cutover/rollback txn + tests + contracts | 1–2 days |
| PR 2: build scripts (create/dry-run/corpus/verify) | 1–2 days |
| PR 2: retrieval parity + verification gates | 1–2 days |
| PR 2: cutover/rollback wiring + tests | 1 day |
| Embedding run (batch, idempotent) | ≤ a few hours |
| **Total (implementation phase)** | ~4–6 days of work |

### Acceptance criteria for PR 1 (Registry Foundation)
1. `git diff` touches only: registry schema module (`src/buildRegistry/`) + pointer/cutover/rollback module + their tests + this design doc. No `src/knowledge/search.js`, no build scripts, no production writes.
2. `npm run check:missing-imports`, `node scripts/run-tests.js` and `npm run test:smoke` are green.
3. New tests cover: schema idempotency (run twice, no error); **atomic init failure-injection → zero registry objects**; default `legacy` pointer; **missing pointer row → `MISSING_ACTIVE_BUILD`**; invalid/non-existent target rejected; **partial unique index rejects a second `active` build (`23505`)**; concurrent cutover serialized via `FOR UPDATE`; failure-injection mid-transaction → full rollback, pointer+status unchanged; rollback restores `previous_build`/legacy without data deletion; **rollback validates the previous target and aborts with `INVALID_PREVIOUS_BUILD` without state change**; **`activate → activate → rollback` restores the immediate previous build, second rollback → `legacy`**; orphan chunk insert rejected by FK (RESTRICT).
4. Migration is additive (verified: existing tables unchanged; new ones only), `git diff --check` clean.
5. Registry is provably never auto-activated (no code path flips `active_build` to a non-legacy value outside an explicit operator action).
6. `active_build` default is `legacy`; nothing references a v2 build until a later cutover PR.
7. The real-PG integration test passes against a PostgreSQL service in CI (and skips cleanly without `TEST_DATABASE_URL`), exercising the same scenarios as the unit suite on a live `pg` Pool.

---

## 10. Verdict and next step

The Build Registry design, after the senior + principal review, is **approved as the target architecture for the versioned PostgreSQL corpus.** All acceptance-criteria concerns are now resolved in this document: additive-only DDL; explicit, separate legacy-vs-v2 read paths read through one `resolveActiveBuild`; atomic pointer transaction; rollback preserving legacy data; single-build keyword/semantic/hybrid consistency; cross-build isolation via composite PK; embedding dimension sourced from the production schema (`768`); canonical inputs excluding `discovered-*`/demo/unavailable/navigation-only; unambiguous dedupe + source-versioning policy; dry-run/resume/idempotency/no-auto-activation; and a verification gate covering counts, determinism, coverage, benchmark, latency and rollback test.

No production writes, migrations, deploy, or PR were performed — this is design only on a clean `phase0b/build-registry-design` branch.

Remaining required actions (each gated on explicit approval):
1. **Rotate** the exposed GitHub PAT and the production DB credential (MUST).
2. Approve and record the **dedupe policy** (§3.4).
3. Approve the DDL (§4) to be applied as an additive migration in the first implementation PR.
4. Implement the first implementation PR per §9 scope + acceptance criteria.
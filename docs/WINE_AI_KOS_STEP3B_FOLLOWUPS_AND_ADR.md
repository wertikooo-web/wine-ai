# WINE AI KOS — Step 3B Follow-Ups & Architecture Decision Record (ADR)

## Status
Accepted & Recorded (2026-07-21)

---

## 1. Context & Purpose
Step 3B (Deterministic Extractors) has been officially accepted. To preserve momentum and focus on building the KOS Source Layer (Step 2C), the following three technical follow-ups are recorded for implementation during post-MVP architectural refinement without blocking Step 2C progress.

---

## 2. Recorded Follow-Ups

### `FOLLOW-UP 3B-1`: Multi-Extractor Evidence Merging Policy
- **Topic**: Determine whether identical normalized candidates produced by *different* extractors (e.g., `kos-label-value-extractor` and `kos-table-extractor`) should be merged into a single `ValidatedFactCandidate` carrying multiple evidence groups, or maintained as distinct candidates until the Entity/Conflict Resolution layer.
- **Current State**: Candidates with identical normalized values produced by the *same* extractor are merged; candidates from different extractors remain distinct.
- **Action Item**: Define an explicit cross-extractor evidence aggregation policy during Entity Resolution planning.

### `FOLLOW-UP 3B-2`: Stability of `extractorsCodeSignatures`
- **Topic**: Confirm that `extractorsCodeSignatures` in `getExtractorRegistryFingerprint()` are platform-independent and resilient to code formatting, whitespace, or transpilation variations of `Function.prototype.toString()`.
- **Current State**: Registry fingerprint incorporates content hashes of `WINE_LABELS`, `WINERY_LABELS`, and extractor definitions.
- **Action Item**: Standardize code signature extraction using AST tokenization or explicit rule hash definitions before multi-developer team expansion.

### `FOLLOW-UP 3B-3`: Mandatory Real PostgreSQL Integration Run for Step 2C
- **Topic**: Ensure that Step 2C (Source Registry & Raw Website Ingestion) includes a mandatory live PostgreSQL integration test run using real `DATABASE_URL` (in addition to the in-memory simulation).
- **Current State**: In-memory PostgreSQL simulator (`tests/helpers/postgresMemoryDb.js`) validates schema logic synchronously.
- **Action Item**: Execute real PostgreSQL schema migrations and integration suites for `kos_sources`, `kos_source_documents`, and `kos_source_document_versions` during Step 2C verification.

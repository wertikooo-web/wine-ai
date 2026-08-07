# Phase 0B Step 1 — Canonical Source Manifest Report

Generated: 2026-08-07T09:41:40.084Z · Production snapshot: 2026-08-07T09:41:22.009Z · Mode: read-only (no writes)

## Arithmetic

| metric | count |
| --- | --- |
| candidates | 489 |
| included | 453 |
| excluded | 36 |
| estimated chunks (included) | 2288 |

### By source type

| source_type | candidates | included | excluded |
| --- | --- | --- | --- |
| kos_source_document | 216 | 182 | 34 |
| approved_crawled_document | 242 | 242 | 0 |
| curated-book | 6 | 6 | 0 |
| curated-manual | 8 | 8 | 0 |
| curated-moldova | 4 | 4 | 0 |
| curated-news | 4 | 4 | 0 |
| curated-demo | 2 | 0 | 2 |
| curated-feteasca | 2 | 2 | 0 |
| curated-uploaded-pdf | 1 | 1 | 0 |
| curated-other | 4 | 4 | 0 |

## Issues

- empty / JS-rendered (no text): **25** (kos:doc_076abd045fc1350f, kos:doc_0dd1855c99bd5f08, kos:doc_1b56c8ad1b73f928, kos:doc_25d1f65e0a68c88b, kos:doc_2d19164dc8078f9d, kos:doc_314ed7de89509908, kos:doc_34fbe67fb95b54e2, kos:doc_44f2d679ae098308, kos:doc_5313ed3939019e59, kos:doc_59640891fb66b76c, …)
- JS-rendered (wine.md / cricova.md): 25
- exact duplicate text groups: 9 (kos:doc_19e0ac15a913d67f == kos:doc_40ab60087e7a3e22 == kos:doc_82c05a52eee9f36f | kos:doc_1de93b47f457ae3e == kos:doc_7e1f428647f41cc9 == kos:doc_80955e22e0f0828a == kos:doc_e39429fafd33cead == kos:doc_e9220d32f2687295 | kos:doc_1fd4bfe973fdbedb == kos:doc_fd881d86f8eb0d44 | kos:doc_3da0d8cc863af206 == disc:doc_9b9e4405ea551d5e | …)
- multiple versions of one source: 4
- demo content (excluded): 2
- internal_reference without external provenance: 0
- curated news vs wine-and-spirits crawled overlap: curated_news=4, crawled=204, exact body overlap=0
- current PG chunks that are duplicates of KOS content (discovered-kos-*): **257**
- unlinkable current PG chunks: 2 ({"discovered-*":2})

## Embeddings / schema facts

- `knowledge_chunk_embeddings`: `chunk_id` TEXT PK NOT NULL, `source_file` TEXT NOT NULL, `model` TEXT NOT NULL, `embedding` `vector(768)` NULL (verified `vector_dims=768`), `content_hash` TEXT NOT NULL, `created_at`/`updated_at` TIMESTAMPTZ; model `gemini-embedding-001`, pgvector 0.8.5, ivfflat index `idx_knowledge_chunk_embeddings_vector` (lists=100), btree index source_file. Total 2555 rows, **all non-null**, 1253 join to `knowledge_chunks`, **1302 orphan embeddings** (no matching chunk); 0 chunks missing an embedding.
- `knowledge_chunks`: PK `chunk_id`; btree indexes source_file, entity_id, document_id.
- runtime reads: `KNOWLEDGE_CHUNK_SOURCE` unset in production → keyword search reads FS `index.json`; semantic candidates read `knowledge_chunk_embeddings` JOIN `knowledge_chunks` directly. So today production hybrid search already mixes FS keyword + PG semantic.
- versioned runtime: a DB pointer (active build id) lets runtime pick legacy vs v2 chunks without redeploy once the versioned runtime mode is enabled — the read path reads the pointer per-request, and cutover/rollback is a single row update.

## Blockers

- exact-duplicate KOS docs: **9 groups / 24 docs** (dedupe policy required before v2 build).
- legacy KOS pipeline (filesystem sync, `knowledge-chunks-sync.js`) is permanently stopped — must not run during v2 build.
- 2 unlinkable legacy PG chunks will be dropped in v2 (no canonical input).
- 1302 orphan embeddings in `knowledge_chunk_embeddings` must not be migrated/kept for v2.

## Canonical input policy (v2 build inputs)

Only these are versioned-build inputs; everything else is treated as derived/legacy and excluded:
- `kos_source_documents` rows with `status=active` AND non-empty `normalized_text` (182 of 216).
- `knowledge_documents` rows with `status=approved` AND non-empty `text` (242 of 242).
- git-committed curated `.md` files with non-empty body, non-`demo` confidence, and an external provenance source (29 of 31; `curated-demo` excluded).
- `index.json` is derived (regenerated at boot), never a build input.

## Versioned runtime read path (legacy + v2 without redeploy)

- Single DB pointer row (e.g. `app_settings.versioned_build_active` = build id) read per-request.
- `active = legacy`: keyword → FS `index.json`, semantic → PG `knowledge_chunk_embeddings` JOIN `knowledge_chunks` (today's behavior).
- `active = <v2 build id>`: both keyword and semantic → v2 tables for that build; cutover/rollback = one row update, no deploy.

## Verdict

**Ready to implement build registry** — canonical input set is well-defined (453 included, 36 excluded with explicit reasons), no blockers beyond a documented dedupe policy for the 9 duplicate groups.

# domains/database.md — Schema, migrations, KOS tables

## Trigger

When the task involves: PostgreSQL, database schema, migrations, KOS tables, knowledge tables, app_settings, pgvector, embeddings.

## Core files

- `src/kos/db/kosSchema.js` — KOS schema migrations (v1-v4)
- `src/knowledge/db.js` — knowledge pipeline tables (knowledge_documents, knowledge_crawl_runs, app_settings, knowledge_chunk_embeddings)
- `src/knowledge/searchMode.js` — app_settings table usage
- `scripts/knowledge-embed-backfill.js` — embedding backfill script

## Key concepts

### Connection

- PostgreSQL via `pg.Pool` with `DATABASE_URL` env var
- SSL enabled when `sslmode=require` in connection string
- `db.isEnabled()` returns `true` when `DATABASE_URL` is set
- `db.init()` creates tables on first call, idempotent

### Knowledge tables (created by `src/knowledge/db.js`)

```sql
-- Document metadata
knowledge_documents (
    id TEXT PRIMARY KEY,
    title TEXT, url TEXT NOT NULL, publisher TEXT,
    published_at TIMESTAMPTZ, fetched_at TIMESTAMPTZ,
    language TEXT, source_id TEXT, trust_level TEXT,
    content_hash TEXT, topics JSONB, entities JSONB,
    summary TEXT, status TEXT, text TEXT,
    last_verified_at TIMESTAMPTZ
)

-- Crawl run tracking
knowledge_crawl_runs (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
    sources_checked INT, new_documents INT,
    duplicates INT, auto_approved INT,
    pending_review INT, errors JSONB
)

-- Runtime settings (search mode, etc.)
app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
)

-- Semantic search embeddings (pgvector)
knowledge_chunk_embeddings (
    chunk_id TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    model TEXT NOT NULL,
    embedding vector(768),
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
)
```

### KOS tables (created by `src/kos/db/kosSchema.js`)

Versioned migrations (v1-v4) with checksum tracking:

- `kos_schema_migrations` — migration tracking
- `kos_wineries` — winery core data
- `kos_profile_versions` — profile versioning (draft/published/archived)
- `kos_winery_profile_state` — active profile state
- `kos_grape_varieties` — grape variety catalog
- `kos_wines` — wine catalog
- `kos_wine_vintages` — vintage details
- `kos_vintage_grape_varieties` — vintage-grape mapping
- `kos_knowledge_sources` — uploaded knowledge sources
- `kos_fact_evidences` — evidence for facts
- `kos_knowledge_facts` — published facts
- `kos_eval_questions` — evaluation questions
- `kos_eval_runs` — evaluation runs

v2 additions:
- `kos_sources` — source registry (seed_url, normalized_origin, trust_level)
- `kos_crawl_runs` — crawl run tracking
- `kos_crawl_run_items` — per-URL crawl items
- `kos_source_documents` — canonical URL mapping
- `kos_source_document_versions` — immutable raw versions
- `kos_parsed_documents` — parsed document storage
- `kos_candidate_drafts` — candidate fact drafts

v3 additions:
- Enriched crawl_run_items (depth, parent_url, discovery_source)
- Updated status CHECK constraints
- Non-negative counter constraints

v4 additions:
- Enriched kos_candidate_drafts (status, validation_errors, identity_hash)
- Enriched kos_knowledge_facts (entity_key, property, version, published_at)
- Enriched kos_fact_evidences (fact_id, candidate_draft_id, quote, char offsets)

### Migration system

- `kos_schema_migrations` table tracks applied migrations
- Checksum computed from migration function source code
- Schema drift detection: throws `KOS_SCHEMA_DRIFT_DETECTED` on checksum mismatch
- Wrapped in transaction with ROLLBACK on failure
- `isKosSchemaReady()` / `getKosSchemaError()` for status checking

### pgvector setup

- Extension: `CREATE EXTENSION IF NOT EXISTS vector`
- Index: `ivfflat` with `vector_cosine_ops` and `lists = 100`
- Graceful degradation: if pgvector unavailable, semantic search stays disabled, keyword search unaffected

## Gotchas

- `app_settings` persists search mode across deploys (in-memory-only would revert to default on `railway up`)
- `knowledge_chunk_embeddings.chunk_id` matches `knowledge/index.js` chunk IDs — not stored in Postgres
- `knowledge/index/index.json` is rebuilt from `knowledge/source/*.md` on every `buildIndex()` call
- KOS schema migrations run at boot (`initKosSchema()` in `src/server.js`)
- `schemaInitialized` / `schemaInitError` track migration state
- SSL connection uses `rejectUnauthorized: false` (Railway managed Postgres)

## Tests

- Schema creation is tested implicitly via integration tests that use real Postgres
- `tests/knowledgeSearch.test.js` — search behavior (implies schema working)

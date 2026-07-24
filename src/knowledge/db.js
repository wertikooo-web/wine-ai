'use strict';

// Postgres connection + schema init for the knowledge pipeline — see
// docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.4. Only active when
// DATABASE_URL is set (Railway sets this automatically once a Postgres
// addon is attached and referenced — see .env.example). Nothing here ever
// reads/prints the connection string; `pg.Pool` consumes it directly from
// the environment.
let pool = null;
let initPromise = null;

function isEnabled() {
    return Boolean(process.env.DATABASE_URL);
}

function getPool() {
    if (!isEnabled()) return null;
    if (!pool) {
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: /sslmode=require/.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false,
        });
    }
    return pool;
}

async function init() {
    if (!isEnabled()) return null;
    if (!initPromise) {
        initPromise = (async () => {
            const p = getPool();
            await p.query(`
                CREATE TABLE IF NOT EXISTS knowledge_documents (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    url TEXT NOT NULL,
                    publisher TEXT,
                    published_at TIMESTAMPTZ,
                    fetched_at TIMESTAMPTZ,
                    language TEXT,
                    source_id TEXT,
                    trust_level TEXT,
                    content_hash TEXT,
                    topics JSONB,
                    entities JSONB,
                    summary TEXT,
                    status TEXT,
                    text TEXT,
                    last_verified_at TIMESTAMPTZ
                );
            `);
            await p.query('CREATE INDEX IF NOT EXISTS idx_knowledge_documents_url ON knowledge_documents(url);');
            await p.query('CREATE INDEX IF NOT EXISTS idx_knowledge_documents_content_hash ON knowledge_documents(content_hash);');
            await p.query('CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status ON knowledge_documents(status);');
            await p.query(`
                CREATE TABLE IF NOT EXISTS knowledge_crawl_runs (
                    id SERIAL PRIMARY KEY,
                    started_at TIMESTAMPTZ,
                    completed_at TIMESTAMPTZ,
                    sources_checked INT,
                    new_documents INT,
                    duplicates INT,
                    auto_approved INT,
                    pending_review INT,
                    errors JSONB
                );
            `);

            // Small generic key/value store for runtime settings toggled
            // from the Dashboard (currently just searchMode.js's knowledge
            // search mode) that need to survive `railway up` replacing the
            // whole container — see src/knowledge/searchMode.js.
            await p.query(`
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            // Semantic search (P0) — chunk_id matches the id knowledge/index.js
            // assigns each chunk when it builds knowledge/index/index.json, so a
            // row here is only ever meaningful alongside a live index entry with
            // the same id (index.json itself is not stored in Postgres — it's
            // rebuilt from knowledge/source/*.md on every buildIndex() call).
            // Nullable `embedding` lets a chunk exist in this table (created at
            // backfill time) before/without a successful embedding call —
            // semantic search treats a NULL embedding as "not yet embedded",
            // never as an error.
            try {
                await p.query('CREATE EXTENSION IF NOT EXISTS vector;');
                await p.query(`
                    CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
                        chunk_id TEXT PRIMARY KEY,
                        source_file TEXT NOT NULL,
                        model TEXT NOT NULL,
                        embedding vector(768),
                        content_hash TEXT NOT NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    );
                `);
                await p.query('CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embeddings_source_file ON knowledge_chunk_embeddings(source_file);');
                // ivfflat needs at least a handful of rows to build meaningful
                // lists; harmless to create early on an empty/small table, and
                // avoids a manual migration step once the corpus grows.
                await p.query(`
                    CREATE INDEX IF NOT EXISTS idx_knowledge_chunk_embeddings_vector
                    ON knowledge_chunk_embeddings
                    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
                `);
            } catch (err) {
                // pgvector extension unavailable on this Postgres instance (some
                // managed providers restrict CREATE EXTENSION) — semantic search
                // stays off, keyword search is unaffected. Never block the rest
                // of knowledge/db.js's (working) schema init over this.
                console.error('[knowledge db] pgvector setup failed — semantic search will stay disabled:', err.message);
            }

            return p;
        })();
    }
    return initPromise;
}

module.exports = { isEnabled, getPool, init };

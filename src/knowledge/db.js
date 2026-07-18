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
            return p;
        })();
    }
    return initPromise;
}

module.exports = { isEnabled, getPool, init };

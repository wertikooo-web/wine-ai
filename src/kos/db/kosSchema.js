'use strict';

/**
 * WINE AI KOS - Database Schema & Versioned Migration Runner (Step 1)
 *
 * Implements strict, idempotent PostgreSQL schema migrations with:
 * - `kos_schema_migrations` migration tracking table
 * - Composite Foreign Keys on `kos_winery_profile_state` (prevents cross-winery active profile version assignments)
 * - Unique constraint on `kos_knowledge_sources(winery_id, checksum_sha256)`
 * - Status CHECK constraints
 * - Automated `updated_at` triggers
 * - Tenant isolation indexes
 */

const db = require('../../knowledge/db');

let schemaInitialized = false;
let schemaInitError = null;

function isKosSchemaReady() {
    return schemaInitialized && !schemaInitError;
}

function getKosSchemaError() {
    return schemaInitError ? schemaInitError.message : null;
}

const MIGRATIONS = [
    {
        version: 1,
        name: 'v1_initial_kos_schema',
        up: async (client) => {
            // 0. Trigger helper for automatic updated_at
            await client.query(`
                CREATE OR REPLACE FUNCTION kos_set_updated_at()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.updated_at = NOW();
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
            `);

            // 1. Wineries Core
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_wineries (
                    id TEXT PRIMARY KEY,
                    slug TEXT UNIQUE NOT NULL,
                    name_official TEXT NOT NULL,
                    brand_name TEXT NOT NULL,
                    country TEXT DEFAULT 'Moldova',
                    region_id TEXT,
                    founded_year INT,
                    total_vineyards_ha NUMERIC(10,2),
                    website_url TEXT,
                    contact_email TEXT,
                    contact_phone TEXT,
                    address_street TEXT,
                    coordinates_lat NUMERIC(10,6),
                    coordinates_lng NUMERIC(10,6),
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_wineries_slug ON kos_wineries(slug);');

            await client.query(`
                DROP TRIGGER IF EXISTS trg_kos_wineries_updated_at ON kos_wineries;
                CREATE TRIGGER trg_kos_wineries_updated_at
                    BEFORE UPDATE ON kos_wineries
                    FOR EACH ROW EXECUTE FUNCTION kos_set_updated_at();
            `);

            // 2. Profile Versions (Needs UNIQUE(id, winery_id) for Composite Foreign Keys)
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_profile_versions (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    version_number INT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived', 'rolled_back')),
                    quality_score NUMERIC(4,3),
                    evaluation_run_id TEXT,
                    published_at TIMESTAMPTZ,
                    published_by TEXT,
                    changelog_summary TEXT,
                    snapshot_json JSONB NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_winery_version UNIQUE(winery_id, version_number),
                    CONSTRAINT uk_version_id_winery UNIQUE(id, winery_id)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_versions_winery ON kos_profile_versions(winery_id);');

            // 3. Separate Winery Profile State (Composite FK ON DELETE RESTRICT prevents cross-winery version assignments and accidental active version deletion)
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_winery_profile_state (
                    winery_id TEXT PRIMARY KEY REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    active_draft_version_id TEXT,
                    active_published_version_id TEXT,
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    FOREIGN KEY (active_draft_version_id, winery_id) REFERENCES kos_profile_versions(id, winery_id) ON DELETE RESTRICT,
                    FOREIGN KEY (active_published_version_id, winery_id) REFERENCES kos_profile_versions(id, winery_id) ON DELETE RESTRICT
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_profile_state_winery ON kos_winery_profile_state(winery_id);');

            await client.query(`
                DROP TRIGGER IF EXISTS trg_kos_winery_profile_state_updated_at ON kos_winery_profile_state;
                CREATE TRIGGER trg_kos_winery_profile_state_updated_at
                    BEFORE UPDATE ON kos_winery_profile_state
                    FOR EACH ROW EXECUTE FUNCTION kos_set_updated_at();
            `);

            // 4. Grape Varieties & Wines
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_grape_varieties (
                    id TEXT PRIMARY KEY,
                    slug TEXT UNIQUE NOT NULL,
                    name_ro TEXT NOT NULL,
                    name_ru TEXT,
                    name_en TEXT,
                    is_autochthonous BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_wines (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    slug TEXT NOT NULL,
                    name_official TEXT NOT NULL,
                    wine_type TEXT,
                    sweetness_level TEXT,
                    line_collection TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_winery_wine_slug UNIQUE(winery_id, slug)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_wines_winery ON kos_wines(winery_id);');

            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_wine_vintages (
                    id TEXT PRIMARY KEY,
                    wine_id TEXT NOT NULL REFERENCES kos_wines(id) ON DELETE CASCADE,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    vintage_year INT NOT NULL,
                    alcohol_percentage NUMERIC(4,2),
                    residual_sugar_g_l NUMERIC(5,2),
                    titratable_acidity_g_l NUMERIC(5,2),
                    aging_details TEXT,
                    oak_months INT,
                    production_volume_bottles INT,
                    serving_temp_celsius TEXT,
                    tasting_notes_json JSONB,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_wine_vintage UNIQUE(wine_id, vintage_year)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_vintages_wine ON kos_wine_vintages(wine_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_vintages_winery ON kos_wine_vintages(winery_id);');

            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_vintage_grape_varieties (
                    vintage_id TEXT NOT NULL REFERENCES kos_wine_vintages(id) ON DELETE CASCADE,
                    grape_id TEXT NOT NULL REFERENCES kos_grape_varieties(id) ON DELETE CASCADE,
                    percentage NUMERIC(5,2),
                    PRIMARY KEY (vintage_id, grape_id)
                );
            `);

            // 5. Knowledge Sources & Evidences
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_knowledge_sources (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    source_type TEXT NOT NULL,
                    title TEXT,
                    original_url TEXT,
                    storage_key TEXT NOT NULL,
                    checksum_sha256 TEXT NOT NULL,
                    size_bytes BIGINT NOT NULL,
                    mime_type TEXT NOT NULL,
                    language TEXT DEFAULT 'auto',
                    document_type TEXT DEFAULT 'unknown',
                    status TEXT NOT NULL CHECK (status IN ('uploaded', 'queued', 'processing', 'processed', 'review_required', 'failed')),
                    raw_text TEXT,
                    imported_at TIMESTAMPTZ DEFAULT NOW(),
                    processed_at TIMESTAMPTZ,
                    metadata JSONB,
                    CONSTRAINT uk_winery_checksum UNIQUE(winery_id, checksum_sha256)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_sources_winery ON kos_knowledge_sources(winery_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_sources_checksum ON kos_knowledge_sources(checksum_sha256);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_sources_status ON kos_knowledge_sources(status);');

            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_fact_evidences (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES kos_knowledge_sources(id) ON DELETE CASCADE,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    page_number INT,
                    page_url TEXT,
                    section_title TEXT,
                    evidence_text TEXT NOT NULL,
                    start_offset INT,
                    end_offset INT,
                    captured_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_evidences_source ON kos_fact_evidences(source_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_evidences_winery ON kos_fact_evidences(winery_id);');

            // 6. Facts & Conflicts
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_knowledge_facts (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    knowledge_type TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT,
                    field_key TEXT NOT NULL,
                    value_json JSONB NOT NULL,
                    normalized_value TEXT,
                    extraction_confidence NUMERIC(3,2) NOT NULL,
                    source_authority NUMERIC(3,2) NOT NULL,
                    freshness_score NUMERIC(3,2) NOT NULL,
                    verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'approved', 'rejected', 'superseded', 'conflicted')),
                    source_id TEXT NOT NULL REFERENCES kos_knowledge_sources(id) ON DELETE CASCADE,
                    evidence_id TEXT NOT NULL REFERENCES kos_fact_evidences(id) ON DELETE CASCADE,
                    extractor_name TEXT NOT NULL,
                    extractor_version TEXT NOT NULL,
                    extracted_at TIMESTAMPTZ DEFAULT NOW(),
                    verified_at TIMESTAMPTZ,
                    verified_by TEXT
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_facts_winery ON kos_knowledge_facts(winery_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_facts_status ON kos_knowledge_facts(verification_status);');

            // 7. Evaluations
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_eval_questions (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    category TEXT NOT NULL,
                    language TEXT NOT NULL,
                    question TEXT NOT NULL,
                    expected_facts JSONB NOT NULL,
                    forbidden_claims JSONB,
                    expected_mode TEXT NOT NULL,
                    should_refuse_to_guess BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_eval_questions_winery ON kos_eval_questions(winery_id);');

            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_eval_runs (
                    id TEXT PRIMARY KEY,
                    winery_id TEXT NOT NULL REFERENCES kos_wineries(id) ON DELETE CASCADE,
                    profile_version_id TEXT NOT NULL REFERENCES kos_profile_versions(id) ON DELETE CASCADE,
                    total_questions INT NOT NULL,
                    passed_questions INT NOT NULL,
                    factual_accuracy NUMERIC(4,3) NOT NULL,
                    groundedness_score NUMERIC(4,3) NOT NULL,
                    hallucination_rate NUMERIC(4,3) NOT NULL,
                    gate_status TEXT NOT NULL CHECK (gate_status IN ('passed', 'blocked')),
                    blocking_reasons JSONB,
                    ran_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_eval_runs_winery ON kos_eval_runs(winery_id);');
        },
    },
    {
        version: 2,
        name: 'v2_sources_and_raw_ingestion_schema',
        up: async (client) => {
            // 1. Source Registry (seed_url & normalized_origin UNIQUE, trust_level DEFAULT 'C')
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    seed_url TEXT NOT NULL,
                    normalized_origin TEXT NOT NULL UNIQUE,
                    source_type TEXT NOT NULL CHECK (source_type IN ('official_website', 'industry_portal', 'government', 'contest', 'media', 'catalog', 'other')),
                    trust_level TEXT NOT NULL DEFAULT 'C' CHECK (trust_level IN ('A', 'B', 'C', 'D')),
                    publisher TEXT,
                    winery_id TEXT REFERENCES kos_wineries(id) ON DELETE SET NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_sources_winery ON kos_sources(winery_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_sources_origin ON kos_sources(normalized_origin);');

            await client.query(`
                DROP TRIGGER IF EXISTS trg_kos_sources_updated_at ON kos_sources;
                CREATE TRIGGER trg_kos_sources_updated_at
                    BEFORE UPDATE ON kos_sources
                    FOR EACH ROW EXECUTE FUNCTION kos_set_updated_at();
            `);

            // 2. Crawl Runs Tracker
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_crawl_runs (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES kos_sources(id) ON DELETE CASCADE,
                    status TEXT NOT NULL CHECK (status IN ('queued', 'crawling', 'stored', 'parsing', 'extracting', 'completed', 'partial', 'failed')),
                    config_snapshot JSONB NOT NULL,
                    pages_discovered INT DEFAULT 0,
                    pages_fetched INT DEFAULT 0,
                    pages_failed INT DEFAULT 0,
                    error_details JSONB,
                    started_at TIMESTAMPTZ DEFAULT NOW(),
                    completed_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_crawl_runs_source ON kos_crawl_runs(source_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_crawl_runs_status ON kos_crawl_runs(status);');

            // 3. Per-URL Crawl Run Items
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_crawl_run_items (
                    id TEXT PRIMARY KEY,
                    crawl_run_id TEXT NOT NULL REFERENCES kos_crawl_runs(id) ON DELETE CASCADE,
                    url TEXT NOT NULL,
                    canonical_url TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'fetched', 'failed')),
                    http_status INT,
                    error_message TEXT,
                    attempt_count INT DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_crawl_items_run ON kos_crawl_run_items(crawl_run_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_crawl_items_status ON kos_crawl_run_items(status);');

            // 4. Source Documents (Canonical URL mapping)
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_source_documents (
                    id TEXT PRIMARY KEY,
                    source_id TEXT NOT NULL REFERENCES kos_sources(id) ON DELETE CASCADE,
                    requested_url TEXT NOT NULL,
                    canonical_url TEXT NOT NULL,
                    content_type TEXT,
                    content_length BIGINT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_source_canonical_url UNIQUE (source_id, canonical_url)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_source_docs_source ON kos_source_documents(source_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_source_docs_canonical ON kos_source_documents(canonical_url);');

            // 5. Immutable Raw Versions (crawl_run_id ON DELETE SET NULL to preserve historical raw provenance)
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_source_document_versions (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES kos_source_documents(id) ON DELETE CASCADE,
                    crawl_run_id TEXT REFERENCES kos_crawl_runs(id) ON DELETE SET NULL,
                    checksum_sha256 TEXT NOT NULL,
                    storage_key TEXT NOT NULL,
                    size_bytes BIGINT NOT NULL,
                    declared_mime_type TEXT NOT NULL,
                    detected_mime_type TEXT NOT NULL,
                    http_headers JSONB NOT NULL,
                    fetched_at TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_document_checksum UNIQUE (document_id, checksum_sha256)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_document ON kos_source_document_versions(document_id);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_checksum ON kos_source_document_versions(checksum_sha256);');
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_doc_versions_crawl_run ON kos_source_document_versions(crawl_run_id);');

            // 6. Parsed Documents
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_parsed_documents (
                    id TEXT PRIMARY KEY,
                    version_id TEXT NOT NULL REFERENCES kos_source_document_versions(id) ON DELETE CASCADE,
                    document_id TEXT NOT NULL REFERENCES kos_source_documents(id) ON DELETE CASCADE,
                    adapter_name TEXT NOT NULL,
                    adapter_version TEXT NOT NULL,
                    canonical_text TEXT NOT NULL,
                    structural_units JSONB NOT NULL,
                    metadata JSONB,
                    parsed_at TIMESTAMPTZ DEFAULT NOW(),
                    CONSTRAINT uk_version_adapter UNIQUE (version_id, adapter_name, adapter_version)
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_parsed_docs_version ON kos_parsed_documents(version_id);');

            // 7. Candidate Drafts
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_candidate_drafts (
                    id TEXT PRIMARY KEY,
                    parsed_document_id TEXT NOT NULL REFERENCES kos_parsed_documents(id) ON DELETE CASCADE,
                    entity_type TEXT NOT NULL,
                    entity_ref JSONB NOT NULL,
                    field_path TEXT NOT NULL,
                    raw_value TEXT NOT NULL,
                    normalized_value JSONB,
                    value_type TEXT NOT NULL,
                    evidence_drafts JSONB NOT NULL,
                    confidence_score NUMERIC(3,2) NOT NULL,
                    extractor_name TEXT NOT NULL,
                    extractor_version TEXT NOT NULL,
                    extracted_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
            await client.query('CREATE INDEX IF NOT EXISTS idx_kos_drafts_parsed_doc ON kos_candidate_drafts(parsed_document_id);');
        },
    },
    {
        version: 3,
        name: 'v3_crawl_items_enrichment_and_constraints',
        up: async (client) => {
            // 1. Add enriched columns to kos_crawl_run_items
            await client.query(`
                ALTER TABLE kos_crawl_run_items
                    ADD COLUMN IF NOT EXISTS depth INT DEFAULT 0,
                    ADD COLUMN IF NOT EXISTS parent_url TEXT,
                    ADD COLUMN IF NOT EXISTS discovery_source TEXT,
                    ADD COLUMN IF NOT EXISTS document_id TEXT REFERENCES kos_source_documents(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS version_id TEXT REFERENCES kos_source_document_versions(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS error_code TEXT,
                    ADD COLUMN IF NOT EXISTS error_details JSONB;
            `);

            // 2. Update status CHECK constraint on kos_crawl_run_items
            await client.query(`
                ALTER TABLE kos_crawl_run_items DROP CONSTRAINT IF EXISTS kos_crawl_run_items_status_check;
                ALTER TABLE kos_crawl_run_items ADD CONSTRAINT kos_crawl_run_items_status_check
                    CHECK (status IN ('queued', 'fetching', 'fetched', 'stored', 'unchanged', 'failed', 'skipped'));
            `);

            // 3. Add UNIQUE constraint UNIQUE(crawl_run_id, canonical_url)
            await client.query(`
                ALTER TABLE kos_crawl_run_items DROP CONSTRAINT IF EXISTS uk_crawl_item_url;
                ALTER TABLE kos_crawl_run_items ADD CONSTRAINT uk_crawl_item_url
                    UNIQUE (crawl_run_id, canonical_url);
            `);

            // 4. Add CHECK constraints for non-negative counters and sizes
            await client.query(`
                ALTER TABLE kos_crawl_run_items DROP CONSTRAINT IF EXISTS chk_crawl_items_attempt_count;
                ALTER TABLE kos_crawl_run_items ADD CONSTRAINT chk_crawl_items_attempt_count
                    CHECK (attempt_count >= 0);

                ALTER TABLE kos_crawl_runs DROP CONSTRAINT IF EXISTS chk_crawl_runs_discovered;
                ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_discovered
                    CHECK (pages_discovered >= 0);

                ALTER TABLE kos_crawl_runs DROP CONSTRAINT IF EXISTS chk_crawl_runs_fetched;
                ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_fetched
                    CHECK (pages_fetched >= 0);

                ALTER TABLE kos_crawl_runs DROP CONSTRAINT IF EXISTS chk_crawl_runs_failed;
                ALTER TABLE kos_crawl_runs ADD CONSTRAINT chk_crawl_runs_failed
                    CHECK (pages_failed >= 0);

                ALTER TABLE kos_source_document_versions DROP CONSTRAINT IF EXISTS chk_doc_versions_size;
                ALTER TABLE kos_source_document_versions ADD CONSTRAINT chk_doc_versions_size
                    CHECK (size_bytes >= 0);
            `);
        },
    },
    {
        version: 4,
        name: 'v4_extraction_and_publication_enrichment',
        up: async (client) => {
            // 1. Enrich kos_candidate_drafts
            await client.query(`
                ALTER TABLE kos_candidate_drafts
                    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'rejected')),
                    ADD COLUMN IF NOT EXISTS validation_errors JSONB,
                    ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES kos_source_documents(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS source_document_version_id TEXT REFERENCES kos_source_document_versions(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS identity_hash TEXT;
            `);

            await client.query(`
                UPDATE kos_candidate_drafts SET status = 'pending' WHERE status IS NULL;
                ALTER TABLE kos_candidate_drafts ALTER COLUMN status SET NOT NULL;
            `);

            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uk_draft_identity
                ON kos_candidate_drafts (parsed_document_id, identity_hash)
                WHERE identity_hash IS NOT NULL;
            `);

            // 2. Enrich kos_knowledge_facts for published facts tracking
            await client.query(`
                ALTER TABLE kos_knowledge_facts
                    ADD COLUMN IF NOT EXISTS entity_key TEXT,
                    ADD COLUMN IF NOT EXISTS property TEXT,
                    ADD COLUMN IF NOT EXISTS source_document_version_id TEXT REFERENCES kos_source_document_versions(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS parsed_document_id TEXT REFERENCES kos_parsed_documents(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS candidate_draft_id TEXT REFERENCES kos_candidate_drafts(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1 CHECK (version > 0),
                    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ DEFAULT NOW();
            `);

            // Make evidence_id nullable in kos_knowledge_facts if needed
            await client.query(`
                ALTER TABLE kos_knowledge_facts ALTER COLUMN evidence_id DROP NOT NULL;
            `);

            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uk_published_fact_version
                ON kos_knowledge_facts (winery_id, entity_type, entity_key, property, version)
                WHERE winery_id IS NOT NULL AND entity_key IS NOT NULL AND property IS NOT NULL;
            `);

            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uk_fact_candidate_draft
                ON kos_knowledge_facts (candidate_draft_id)
                WHERE candidate_draft_id IS NOT NULL;
            `);

            // 3. Enrich kos_fact_evidences for candidate draft linking and multiple evidences per fact
            await client.query(`
                ALTER TABLE kos_fact_evidences
                    ADD COLUMN IF NOT EXISTS fact_id TEXT REFERENCES kos_knowledge_facts(id) ON DELETE CASCADE,
                    ADD COLUMN IF NOT EXISTS candidate_draft_id TEXT REFERENCES kos_candidate_drafts(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS parsed_document_id TEXT REFERENCES kos_parsed_documents(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS source_document_id TEXT REFERENCES kos_source_documents(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS source_document_version_id TEXT REFERENCES kos_source_document_versions(id) ON DELETE SET NULL,
                    ADD COLUMN IF NOT EXISTS quote TEXT,
                    ADD COLUMN IF NOT EXISTS char_start INT,
                    ADD COLUMN IF NOT EXISTS char_end INT;
            `);

            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS uk_fact_evidence_candidate
                ON kos_fact_evidences (candidate_draft_id)
                WHERE candidate_draft_id IS NOT NULL;
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS idx_kos_evidences_fact ON kos_fact_evidences(fact_id);
            `);
        },
    },
];

const crypto = require('crypto');

function computeMigrationChecksum(migration) {
    const codeStr = typeof migration.up === 'function' ? migration.up.toString() : String(migration.up);
    return crypto.createHash('sha256').update(codeStr).digest('hex');
}

async function initKosSchema() {
    if (!db.isEnabled()) {
        schemaInitialized = true;
        schemaInitError = null;
        return null;
    }

    try {
        const pool = db.getPool();
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Migration tracking table
            await client.query(`
                CREATE TABLE IF NOT EXISTS kos_schema_migrations (
                    version INT PRIMARY KEY,
                    name TEXT NOT NULL,
                    checksum TEXT NOT NULL,
                    applied_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);

            const { rows: appliedRows } = await client.query('SELECT version, checksum, name FROM kos_schema_migrations');
            const appliedMap = new Map(appliedRows.map((r) => [r.version, r]));

            for (const migration of MIGRATIONS) {
                const currentChecksum = computeMigrationChecksum(migration);
                const applied = appliedMap.get(migration.version);

                if (applied) {
                    // Detect Schema Drift
                    if (applied.checksum !== currentChecksum && applied.checksum !== 'dev') {
                        throw Object.assign(
                            new Error(`KOS_SCHEMA_DRIFT_DETECTED: Migration v${migration.version} (${migration.name}) checksum mismatch. Stored: ${applied.checksum}, Current: ${currentChecksum}`),
                            { code: 'KOS_SCHEMA_DRIFT_DETECTED', version: migration.version, name: migration.name }
                        );
                    }
                } else {
                    await migration.up(client);
                    await client.query(
                        'INSERT INTO kos_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
                        [migration.version, migration.name, currentChecksum]
                    );
                }
            }

            await client.query('COMMIT');
            schemaInitialized = true;
            schemaInitError = null;
            return pool;
        } catch (err) {
            await client.query('ROLLBACK');
            schemaInitialized = false;
            schemaInitError = err;
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        schemaInitialized = false;
        schemaInitError = err;
        throw err;
    }
}

module.exports = {
    initKosSchema,
    isKosSchemaReady,
    getKosSchemaError,
};

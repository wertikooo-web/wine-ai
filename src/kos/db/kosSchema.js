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
];

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

            const { rows: appliedRows } = await client.query('SELECT version FROM kos_schema_migrations');
            const appliedVersions = new Set(appliedRows.map((r) => r.version));

            for (const migration of MIGRATIONS) {
                if (!appliedVersions.has(migration.version)) {
                    await migration.up(client);
                    const migrationChecksum = db.isEnabled() ? migration.name : 'dev';
                    await client.query(
                        'INSERT INTO kos_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
                        [migration.version, migration.name, migrationChecksum]
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

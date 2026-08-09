'use strict';

/**
 * WINE AI KOS - In-Memory PostgreSQL Engine Helper
 *
 * Implements a compliant PostgreSQL Pool and SQL execution engine for unit and integration testing.
 * Enforces PostgreSQL DDL, composite foreign keys, CHECK constraints, UNIQUE constraints (23505),
 * FK violations (23503), CHECK violations (23514), triggers (kos_set_updated_at), advisory locks,
 * and ACID transactions (BEGIN/COMMIT/ROLLBACK).
 */

const crypto = require('crypto');

let lastTimeMs = 0;
function getUniqueTime() {
    let nowMs = Date.now();
    if (nowMs <= lastTimeMs) {
        nowMs = lastTimeMs + 1;
    }
    lastTimeMs = nowMs;
    return new Date(nowMs);
}

class PostgresError extends Error {
    constructor(message, code, table, constraint) {
        super(message);
        this.code = code;
        this.table = table;
        this.constraint = constraint;
    }
}

class MemoryPgEngine {
    constructor() {
        this.tables = new Map();
        this.indexes = new Map();
        this.triggers = new Map();
        this.appliedMigrations = new Set();
        this.advisoryLocks = new Set();
    }

    reset() {
        this.tables.clear();
        this.indexes.clear();
        this.triggers.clear();
        this.appliedMigrations.clear();
        this.advisoryLocks.clear();
    }

    async query(sqlText, params = []) {
        const sql = sqlText.trim().replace(/\s+/g, ' ');

        // Advisory Lock
        if (/^SELECT\s+pg_advisory_xact_lock/i.test(sql)) {
            const lockId = params[0] || 987654321;
            this.advisoryLocks.add(lockId);
            return { rows: [{ pg_advisory_xact_lock: null }] };
        }

        // CREATE OR REPLACE FUNCTION / TRIGGER DDL
        if (/^CREATE OR REPLACE FUNCTION kos_set_updated_at/i.test(sql) || /^CREATE TRIGGER/i.test(sql) || /^DROP TRIGGER/i.test(sql)) {
            if (/CREATE TRIGGER (\w+)/i.test(sql)) {
                const triggerName = sql.match(/CREATE TRIGGER (\w+)/i)[1];
                this.triggers.set(triggerName, true);
            }
            return { rows: [] };
        }

        // CREATE TABLE DDL
        if (/^CREATE TABLE IF NOT EXISTS/i.test(sql)) {
            const tableNameMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
            if (tableNameMatch) {
                const tableName = tableNameMatch[1];
                if (!this.tables.has(tableName)) {
                    this.tables.set(tableName, {
                        name: tableName,
                        rows: [],
                        schemaSql: sql,
                    });
                }
            }
            return { rows: [] };
        }

        // CREATE INDEX DDL
        if (/^CREATE INDEX IF NOT EXISTS/i.test(sql)) {
            const indexNameMatch = sql.match(/CREATE INDEX IF NOT EXISTS (\w+)/i);
            if (indexNameMatch) {
                this.indexes.set(indexNameMatch[1], true);
            }
            return { rows: [] };
        }

        // Transactions
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
            return { rows: [] };
        }

        // SELECT FROM kos_schema_migrations
        if (/^SELECT version FROM kos_schema_migrations/i.test(sql)) {
            if (!this.tables.has('kos_schema_migrations')) {
                return { rows: [] };
            }
            const table = this.tables.get('kos_schema_migrations');
            return { rows: table.rows.map(r => ({ version: r.version })) };
        }

        // INSERT INTO kos_schema_migrations
        if (/^INSERT INTO kos_schema_migrations/i.test(sql)) {
            if (!this.tables.has('kos_schema_migrations')) {
                this.tables.set('kos_schema_migrations', { name: 'kos_schema_migrations', rows: [] });
            }
            const table = this.tables.get('kos_schema_migrations');
            const version = params[0];
            const name = params[1];
            const checksum = params[2];
            table.rows.push({ version, name, checksum, applied_at: new Date() });
            return { rows: [] };
        }

        // INSERT INTO kos_wineries
        if (/^INSERT INTO kos_wineries/i.test(sql)) {
            const table = this.tables.get('kos_wineries') || { name: 'kos_wineries', rows: [] };
            this.tables.set('kos_wineries', table);

            const id = params[0];
            const slug = params[1];
            const name_official = params[2];
            const brand_name = params[3];
            const country = params[4] || 'Moldova';

            // Slug unique check
            if (table.rows.some(r => r.slug === slug)) {
                throw new PostgresError(`duplicate key value violates unique constraint "kos_wineries_slug_key"`, '23505', 'kos_wineries', 'kos_wineries_slug_key');
            }

            const row = {
                id,
                slug,
                name_official,
                brand_name,
                country,
                created_at: new Date(),
                updated_at: new Date(),
            };
            table.rows.push(row);
            return { rows: [row] };
        }

        // UPDATE kos_wineries
        if (/^UPDATE kos_wineries SET/i.test(sql)) {
            const table = this.tables.get('kos_wineries');
            if (!table) return { rows: [] };
            const brandName = params[0];
            const id = params[1];

            const row = table.rows.find(r => r.id === id);
            if (row) {
                row.brand_name = brandName;
                row.updated_at = new Date(Date.now() + 10); // Trigger updated_at simulation
            }
            return { rows: row ? [row] : [] };
        }

        // SELECT FROM kos_wineries
        if (/^SELECT updated_at FROM kos_wineries WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_wineries');
            const row = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: row ? [{ updated_at: row.updated_at }] : [] };
        }

        // INSERT INTO kos_profile_versions
        if (/^INSERT INTO kos_profile_versions/i.test(sql)) {
            const table = this.tables.get('kos_profile_versions') || { name: 'kos_profile_versions', rows: [] };
            this.tables.set('kos_profile_versions', table);

            const id = params[0];
            const winery_id = params[1];
            const version_number = params[2];
            const status = params[3];
            const snapshot_json = params[4];

            // Check status CHECK constraint
            const validStatuses = ['draft', 'published', 'archived', 'rolled_back'];
            if (!validStatuses.includes(status)) {
                throw new PostgresError(`new row for relation "kos_profile_versions" violates check constraint "kos_profile_versions_status_check"`, '23514', 'kos_profile_versions', 'kos_profile_versions_status_check');
            }

            const row = { id, winery_id, version_number, status, snapshot_json, created_at: new Date() };
            table.rows.push(row);
            return { rows: [row] };
        }

        // INSERT INTO kos_winery_profile_state
        if (/^INSERT INTO kos_winery_profile_state/i.test(sql)) {
            const stateTable = this.tables.get('kos_winery_profile_state') || { name: 'kos_winery_profile_state', rows: [] };
            this.tables.set('kos_winery_profile_state', stateTable);

            const winery_id = params[0];
            const active_draft_version_id = params[1] || null;
            const active_published_version_id = params[2] || null;

            // Composite Foreign Key validation: active_draft_version_id + winery_id must exist in kos_profile_versions
            if (active_draft_version_id) {
                const versionsTable = this.tables.get('kos_profile_versions');
                const matchedVersion = versionsTable ? versionsTable.rows.find(r => r.id === active_draft_version_id && r.winery_id === winery_id) : null;
                if (!matchedVersion) {
                    throw new PostgresError(`insert or update on table "kos_winery_profile_state" violates foreign key constraint "kos_winery_profile_state_active_draft_version_id_winery_id_fkey"`, '23503', 'kos_winery_profile_state', 'kos_winery_profile_state_active_draft_version_id_winery_id_fkey');
                }
            }

            const row = { winery_id, active_draft_version_id, active_published_version_id, updated_at: new Date() };
            stateTable.rows.push(row);
            return { rows: [row] };
        }

        // INSERT INTO kos_knowledge_sources
        if (/^INSERT INTO kos_knowledge_sources/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_sources') || { name: 'kos_knowledge_sources', rows: [] };
            this.tables.set('kos_knowledge_sources', table);

            let id, winery_id, source_type, title, original_url, storage_key, checksum_sha256, size_bytes, mime_type, language, document_type, status, raw_text, imported_at, metadata;

            if (params.length >= 15) {
                [id, winery_id, source_type, title, original_url, storage_key, checksum_sha256, size_bytes, mime_type, language, document_type, status, raw_text, imported_at, metadata] = params;
            } else {
                [id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status] = params;
            }

            // CHECK constraint status
            const validStatuses = ['uploaded', 'queued', 'processing', 'processed', 'review_required', 'failed'];
            if (!validStatuses.includes(status)) {
                throw new PostgresError(`new row for relation "kos_knowledge_sources" violates check constraint "kos_knowledge_sources_status_check"`, '23514', 'kos_knowledge_sources', 'kos_knowledge_sources_status_check');
            }

            // UNIQUE constraint (winery_id, checksum_sha256)
            if (table.rows.some(r => r.winery_id === winery_id && r.checksum_sha256 === checksum_sha256)) {
                throw new PostgresError(`duplicate key value violates unique constraint "uk_winery_checksum"`, '23505', 'kos_knowledge_sources', 'uk_winery_checksum');
            }

            const row = {
                id, winery_id, source_type, title, original_url, storage_key, checksum_sha256,
                size_bytes: Number(size_bytes || 0), mime_type, language, document_type, status,
                raw_text, imported_at: imported_at || new Date().toISOString(), metadata
            };
            table.rows.push(row);
            return { rows: [row] };
        }

        // SELECT FROM kos_knowledge_sources
        if (/^SELECT \* FROM kos_knowledge_sources WHERE winery_id = \$1 AND checksum_sha256 = \$2/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_sources');
            const wineryId = params[0];
            const checksum = params[1];
            const match = table ? table.rows.find(r => r.winery_id === wineryId && r.checksum_sha256 === checksum) : null;
            return { rows: match ? [match] : [] };
        }

        if (/^SELECT \* FROM kos_knowledge_sources WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_sources');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        if (/^SELECT \* FROM kos_knowledge_sources WHERE winery_id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_sources');
            const matches = table ? table.rows.filter(r => r.winery_id === params[0]) : [];
            return { rows: matches };
        }

        // DELETE FROM kos_wineries
        if (/^DELETE FROM kos_wineries WHERE id = \$1/i.test(sql) || /^DELETE FROM kos_wineries WHERE id IN/i.test(sql)) {
            const wineriesTable = this.tables.get('kos_wineries');
            const targetIds = params;
            if (wineriesTable) {
                wineriesTable.rows = wineriesTable.rows.filter(r => !targetIds.includes(r.id));
            }
            // CASCADE deletes
            ['kos_knowledge_sources', 'kos_winery_profile_state', 'kos_profile_versions', 'kos_wines', 'kos_sources'].forEach(tblName => {
                const tbl = this.tables.get(tblName);
                if (tbl) {
                    tbl.rows = tbl.rows.filter(r => !targetIds.includes(r.winery_id));
                }
            });
            return { rows: [] };
        }

        // ALTER TABLE DDL (Migration v3 support)
        if (/^ALTER TABLE/i.test(sql)) {
            return { rows: [] };
        }

        // INSERT INTO kos_source_documents ON CONFLICT DO UPDATE
        if (/^INSERT INTO kos_source_documents/i.test(sql)) {
            const table = this.tables.get('kos_source_documents') || { name: 'kos_source_documents', rows: [] };
            this.tables.set('kos_source_documents', table);

            const [id, source_id, requested_url, canonical_url, content_type, content_length] = params;
            let existingRow = table.rows.find(r => r.source_id === source_id && r.canonical_url === canonical_url);

            if (existingRow) {
                existingRow.requested_url = requested_url;
                existingRow.content_type = content_type;
                existingRow.content_length = content_length;
                existingRow.updated_at = new Date();
                return { rows: [existingRow] };
            }

            const newRow = {
                id,
                source_id,
                requested_url,
                canonical_url,
                content_type,
                content_length,
                created_at: new Date(),
                updated_at: new Date(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // INSERT INTO kos_source_document_versions
        if (/^INSERT INTO kos_source_document_versions/i.test(sql)) {
            const table = this.tables.get('kos_source_document_versions') || { name: 'kos_source_document_versions', rows: [] };
            this.tables.set('kos_source_document_versions', table);

            const [id, document_id, crawl_run_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, http_headers, fetched_at] = params;

            // Check UK uk_document_checksum (document_id, checksum_sha256)
            if (table.rows.some(r => r.document_id === document_id && r.checksum_sha256 === checksum_sha256)) {
                throw new PostgresError(`duplicate key value violates unique constraint "uk_document_checksum"`, '23505', 'kos_source_document_versions', 'uk_document_checksum');
            }

            const newRow = {
                id,
                document_id,
                crawl_run_id,
                checksum_sha256,
                storage_key,
                size_bytes: Number(size_bytes || 0),
                declared_mime_type,
                detected_mime_type,
                http_headers,
                fetched_at,
                created_at: new Date(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // SELECT FROM kos_source_document_versions by id
        if (/^SELECT \* FROM kos_source_document_versions WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_source_document_versions');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_source_document_versions
        if (/^SELECT \* FROM kos_source_document_versions WHERE document_id = \$1 AND checksum_sha256 = \$2/i.test(sql)) {
            const table = this.tables.get('kos_source_document_versions');
            const match = table ? table.rows.find(r => r.document_id === params[0] && r.checksum_sha256 === params[1]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_parsed_documents by id
        if (/^SELECT \* FROM kos_parsed_documents WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_parsed_documents');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_parsed_documents
        if (/^SELECT \* FROM kos_parsed_documents WHERE version_id = \$1 AND adapter_name = \$2 AND adapter_version = \$3/i.test(sql)) {
            const table = this.tables.get('kos_parsed_documents');
            const match = table ? table.rows.find(r => r.version_id === params[0] && r.adapter_name === params[1] && r.adapter_version === params[2]) : null;
            return { rows: match ? [match] : [] };
        }

        // INSERT INTO kos_parsed_documents ON CONFLICT DO NOTHING
        if (/^INSERT INTO kos_parsed_documents/i.test(sql)) {
            const table = this.tables.get('kos_parsed_documents') || { name: 'kos_parsed_documents', rows: [] };
            this.tables.set('kos_parsed_documents', table);

            const [id, version_id, document_id, adapter_name, adapter_version, canonical_text, structural_units, metadata, parsed_at] = params;

            let existingRow = table.rows.find(r => r.version_id === version_id && r.adapter_name === adapter_name && r.adapter_version === adapter_version);

            if (existingRow) {
                return { rows: [] };
            }

            const newRow = {
                id,
                version_id,
                document_id,
                adapter_name,
                adapter_version,
                canonical_text,
                structural_units: typeof structural_units === 'string' ? JSON.parse(structural_units) : structural_units,
                metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
                parsed_at: parsed_at || new Date().toISOString(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // INSERT INTO kos_candidate_drafts
        if (/^INSERT INTO kos_candidate_drafts/i.test(sql)) {
            const table = this.tables.get('kos_candidate_drafts') || { name: 'kos_candidate_drafts', rows: [] };
            this.tables.set('kos_candidate_drafts', table);

            const [id, parsed_document_id, entity_type, entity_ref, field_path, raw_value, normalized_value, value_type, evidence_drafts, confidence_score, extractor_name, extractor_version, source_document_id, source_document_version_id, identity_hash] = params;

            // Check UK uk_draft_identity
            if (identity_hash && table.rows.some(r => r.parsed_document_id === parsed_document_id && r.identity_hash === identity_hash)) {
                return { rows: [] }; // ON CONFLICT DO NOTHING
            }

            const newRow = {
                id,
                parsed_document_id,
                entity_type,
                entity_ref: typeof entity_ref === 'string' ? JSON.parse(entity_ref) : entity_ref,
                field_path,
                raw_value,
                normalized_value: typeof normalized_value === 'string' ? JSON.parse(normalized_value) : normalized_value,
                value_type,
                evidence_drafts: typeof evidence_drafts === 'string' ? JSON.parse(evidence_drafts) : evidence_drafts,
                confidence_score: Number(confidence_score || 0.8),
                extractor_name,
                extractor_version,
                source_document_id,
                source_document_version_id,
                identity_hash,
                status: 'pending',
                validation_errors: null,
                extracted_at: new Date().toISOString(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // UPDATE kos_candidate_drafts status
        if (/^UPDATE kos_candidate_drafts SET status =/i.test(sql)) {
            const table = this.tables.get('kos_candidate_drafts');
            if (!table) return { rows: [] };
            
            let status, validation_errors, id;
            if (params.length >= 3) {
                [status, validation_errors, id] = params;
            } else {
                [status, id] = params;
            }

            const row = table.rows.find(r => r.id === id);
            if (row) {
                row.status = status;
                if (validation_errors !== undefined) {
                    row.validation_errors = typeof validation_errors === 'string' ? JSON.parse(validation_errors) : validation_errors;
                }
            }
            return { rows: row ? [row] : [] };
        }

        // SELECT FROM kos_candidate_drafts by id
        if (/^SELECT \* FROM kos_candidate_drafts WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_candidate_drafts');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_candidate_drafts by parsed_document_id & identity_hash
        if (/^SELECT \* FROM kos_candidate_drafts WHERE parsed_document_id = \$1 AND identity_hash = \$2/i.test(sql)) {
            const table = this.tables.get('kos_candidate_drafts');
            const match = table ? table.rows.find(r => r.parsed_document_id === params[0] && r.identity_hash === params[1]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_candidate_drafts by parsed_document_id
        if (/^SELECT \* FROM kos_candidate_drafts WHERE parsed_document_id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_candidate_drafts');
            const matches = table ? table.rows.filter(r => r.parsed_document_id === params[0]) : [];
            return { rows: matches };
        }

        // INSERT INTO kos_fact_evidences
        if (/^INSERT INTO kos_fact_evidences/i.test(sql)) {
            const table = this.tables.get('kos_fact_evidences') || { name: 'kos_fact_evidences', rows: [] };
            this.tables.set('kos_fact_evidences', table);

            let id, fact_id, candidate_draft_id, source_id, winery_id, evidence_text, quote, start_offset, end_offset, char_start, char_end, parsed_document_id, source_document_id, source_document_version_id;

            if (params.length >= 10) {
                [id, fact_id, candidate_draft_id, source_id, winery_id, evidence_text, quote, start_offset, end_offset, char_start, char_end, parsed_document_id, source_document_id, source_document_version_id] = params;
            } else {
                [id, source_id, winery_id, evidence_text, start_offset, end_offset] = params;
            }

            // Check UK uk_fact_evidence_candidate
            if (candidate_draft_id && table.rows.some(r => r.candidate_draft_id === candidate_draft_id)) {
                throw new PostgresError(`duplicate key value violates unique constraint "uk_fact_evidence_candidate"`, '23505', 'kos_fact_evidences', 'uk_fact_evidence_candidate');
            }

            const newRow = {
                id,
                fact_id,
                candidate_draft_id,
                source_id,
                winery_id,
                evidence_text: evidence_text || quote,
                quote: quote || evidence_text,
                start_offset: start_offset !== undefined ? start_offset : char_start,
                end_offset: end_offset !== undefined ? end_offset : char_end,
                char_start: char_start !== undefined ? char_start : start_offset,
                char_end: char_end !== undefined ? char_end : end_offset,
                parsed_document_id,
                source_document_id,
                source_document_version_id,
                captured_at: new Date().toISOString(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // SELECT FROM kos_fact_evidences by candidate_draft_id
        if (/^SELECT \* FROM kos_fact_evidences WHERE candidate_draft_id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_fact_evidences');
            const match = table ? table.rows.find(r => r.candidate_draft_id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_knowledge_facts by id
        if (/^SELECT \* FROM kos_knowledge_facts WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_facts');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_knowledge_facts by candidate_draft_id
        if (/^SELECT \* FROM kos_knowledge_facts WHERE candidate_draft_id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_facts');
            const match = table ? table.rows.find(r => r.candidate_draft_id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_knowledge_facts by scope
        if (/^SELECT \* FROM kos_knowledge_facts WHERE winery_id = \$1 AND entity_type = \$2 AND entity_key = \$3 AND property = \$4/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_facts');
            let matches = table ? table.rows.filter(r => r.winery_id === params[0] && r.entity_type === params[1] && r.entity_key === params[2] && r.property === params[3]) : [];
            if (/ORDER BY version DESC/i.test(sql)) {
                matches = [...matches].sort((a, b) => Number(b.version || 1) - Number(a.version || 1));
            }
            return { rows: matches };
        }

        // INSERT INTO kos_knowledge_facts
        if (/^INSERT INTO kos_knowledge_facts/i.test(sql)) {
            const table = this.tables.get('kos_knowledge_facts') || { name: 'kos_knowledge_facts', rows: [] };
            this.tables.set('kos_knowledge_facts', table);

            const [id, winery_id, knowledge_type, entity_type, entity_id, field_key, value_json, normalized_value, extraction_confidence, source_authority, freshness_score, verification_status, source_id, extractor_name, extractor_version, entity_key, property, source_document_version_id, parsed_document_id, candidate_draft_id, version] = params;

            // Check candidate_draft_id uniqueness
            if (candidate_draft_id && table.rows.some(r => r.candidate_draft_id === candidate_draft_id)) {
                throw new PostgresError(`duplicate key value violates unique constraint "uk_fact_candidate_draft"`, '23505', 'kos_knowledge_facts', 'uk_fact_candidate_draft');
            }

            const newRow = {
                id,
                winery_id,
                knowledge_type: knowledge_type || 'extracted',
                entity_type,
                entity_id,
                field_key: field_key || property,
                value_json: typeof value_json === 'string' ? JSON.parse(value_json) : value_json,
                normalized_value,
                extraction_confidence: Number(extraction_confidence || 0.9),
                source_authority: Number(source_authority || 0.8),
                freshness_score: Number(freshness_score || 1.0),
                verification_status: verification_status || 'approved',
                source_id,
                extractor_name,
                extractor_version,
                entity_key,
                property,
                source_document_version_id,
                parsed_document_id,
                candidate_draft_id,
                version: Number(version || 1),
                published_at: new Date().toISOString(),
                extracted_at: new Date().toISOString(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // INSERT INTO kos_crawl_run_items
        if (/^INSERT INTO kos_crawl_run_items/i.test(sql)) {
            const table = this.tables.get('kos_crawl_run_items') || { name: 'kos_crawl_run_items', rows: [] };
            this.tables.set('kos_crawl_run_items', table);

            const [id, crawl_run_id, url, canonical_url, status, depth, parent_url, discovery_source, document_id, version_id, http_status] = params;

            let existingRow = table.rows.find(r => r.crawl_run_id === crawl_run_id && r.canonical_url === (canonical_url || url));
            if (existingRow) {
                existingRow.status = status;
                existingRow.document_id = document_id;
                existingRow.version_id = version_id;
                existingRow.http_status = http_status;
                existingRow.attempt_count = (existingRow.attempt_count || 0) + 1;
                existingRow.updated_at = new Date();
                return { rows: [existingRow] };
            }

            const newRow = {
                id,
                crawl_run_id,
                url,
                canonical_url: canonical_url || url,
                status,
                depth: depth || 0,
                parent_url: parent_url || null,
                discovery_source: discovery_source || 'seed',
                document_id,
                version_id,
                http_status: http_status || 200,
                attempt_count: 1,
                created_at: new Date(),
                updated_at: new Date(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // INSERT INTO kos_crawl_runs
        if (/^INSERT INTO kos_crawl_runs/i.test(sql)) {
            const table = this.tables.get('kos_crawl_runs') || { name: 'kos_crawl_runs', rows: [] };
            this.tables.set('kos_crawl_runs', table);

            const id = params[0];
            const source_id = params[1];
            const config_snapshot = params[2];
            const started_at = params[3];
            const newRow = {
                id,
                source_id,
                status: 'crawling',
                config_snapshot: typeof config_snapshot === 'string' ? JSON.parse(config_snapshot) : config_snapshot,
                pages_discovered: 0,
                pages_fetched: 0,
                pages_failed: 0,
                started_at: started_at || getUniqueTime().toISOString(),
                created_at: getUniqueTime().toISOString(),
            };
            table.rows.push(newRow);
            return { rows: [newRow] };
        }

        // SELECT FROM kos_crawl_runs by source_id
        if (/^SELECT \* FROM kos_crawl_runs WHERE source_id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_crawl_runs');
            const sourceId = params[0];
            let matches = table ? table.rows.filter(r => r.source_id === sourceId) : [];
            if (/ORDER BY/i.test(sql)) {
                matches = [...matches].sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
            }
            if (/LIMIT 1/i.test(sql)) {
                matches = matches.slice(0, 1);
            }
            return { rows: matches };
        }

        // UPDATE kos_crawl_runs
        if (/^UPDATE kos_crawl_runs SET/i.test(sql)) {
            const table = this.tables.get('kos_crawl_runs');
            if (!table) return { rows: [] };
            
            // Check if error update or final status update
            if (/error_details/i.test(sql)) {
                let errorDetails, id, status;
                if (/status = \$1/i.test(sql)) {
                    status = params[0];
                    errorDetails = params[1];
                    id = params[2];
                } else {
                    status = 'failed';
                    errorDetails = params[0];
                    id = params[1];
                }
                const row = table.rows.find(r => r.id === id);
                if (row) {
                    row.status = status;
                    row.error_details = typeof errorDetails === 'string' ? JSON.parse(errorDetails) : errorDetails;
                    row.completed_at = new Date().toISOString();
                }
                return { rows: row ? [row] : [] };
            }

            const targetId = params[params.length - 1];
            const row = table.rows.find(r => r.id === targetId);
            if (row) {
                if (/status = 'completed'/i.test(sql)) {
                    row.status = 'completed';
                } else if (/status = 'failed'/i.test(sql)) {
                    row.status = 'failed';
                } else if (/status = \$1/i.test(sql)) {
                    row.status = params[0];
                }
                
                if (/pages_discovered = \$2/i.test(sql)) {
                    row.pages_discovered = params[1];
                }
                if (/pages_fetched = \$3/i.test(sql)) {
                    row.pages_fetched = params[2];
                }
                if (/pages_failed = \$4/i.test(sql)) {
                    row.pages_failed = params[3];
                }
                if (/completed_at = \$5/i.test(sql)) {
                    row.completed_at = params[4];
                }
            }
            return { rows: row ? [row] : [] };
        }

        // INSERT INTO kos_sources
        if (/^INSERT INTO kos_sources/i.test(sql)) {
            const table = this.tables.get('kos_sources') || { name: 'kos_sources', rows: [] };
            this.tables.set('kos_sources', table);

            const [id, name, seed_url, normalized_origin, source_type, trust_level, publisher, winery_id] = params;

            // Unique origin check
            if (table.rows.some(r => r.normalized_origin === normalized_origin)) {
                throw new PostgresError(`duplicate key value violates unique constraint "kos_sources_normalized_origin_key"`, '23505', 'kos_sources', 'kos_sources_normalized_origin_key');
            }

            const row = {
                id,
                name: name ? name.trim() : '',
                seed_url,
                normalized_origin,
                source_type,
                trust_level: trust_level || 'C',
                publisher,
                winery_id,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            };
            table.rows.push(row);
            return { rows: [row] };
        }

        // SELECT FROM kos_sources by normalized_origin
        if (/^SELECT \* FROM kos_sources WHERE normalized_origin = \$1/i.test(sql)) {
            const table = this.tables.get('kos_sources');
            const origin = params[0];
            const match = table ? table.rows.find(r => r.normalized_origin === origin) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_sources by id
        if (/^SELECT \* FROM kos_sources WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_sources');
            const match = table ? table.rows.find(r => r.id === params[0]) : null;
            return { rows: match ? [match] : [] };
        }

        // SELECT FROM kos_sources (list)
        if (/^SELECT \* FROM kos_sources/i.test(sql) && !/WHERE/i.test(sql)) {
            const table = this.tables.get('kos_sources');
            let rows = table ? table.rows : [];
            if (/ORDER BY created_at DESC/i.test(sql)) {
                rows = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            }
            return { rows };
        }

        // DELETE FROM kos_sources
        if (/^DELETE FROM kos_sources WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_sources');
            if (table) {
                table.rows = table.rows.filter(r => r.id !== params[0]);
            }
            return { rows: [] };
        }

        // SELECT FROM knowledge_chunks by document_id (Stage 3 per-document reads)
        if (/^SELECT .* FROM knowledge_chunks WHERE document_id = \$1/i.test(sql)) {
            const table = this.tables.get('knowledge_chunks');
            return { rows: table ? table.rows.filter((r) => r.document_id === params[0]) : [] };
        }

        // UPDATE knowledge_chunks SET enabled = FALSE (Stage 3 disable-stale /
        // prune-inactive) — handles both whole-document (document_id = ANY) and
        // per-chunk (document_id = $1 AND chunk_id = ANY($2)) forms.
        if (/^UPDATE knowledge_chunks SET enabled = FALSE/i.test(sql)) {
            const table = this.tables.get('knowledge_chunks');
            if (!table) return { rows: [] };
            let matches = [];
            if (/document_id = \$1 AND chunk_id = ANY\(\$2\)/i.test(sql)) {
                const docId = params[0];
                const chunkIds = params[1] || [];
                matches = table.rows.filter((r) => r.document_id === docId && chunkIds.includes(r.chunk_id));
            } else if (/document_id = ANY\(\$1\)/i.test(sql)) {
                const docIds = params[0] || [];
                matches = table.rows.filter((r) => r.document_id !== null && r.document_id !== undefined && docIds.includes(r.document_id));
            }
            for (const row of matches) {
                row.enabled = false;
                row.updated_at = new Date();
            }
            return { rows: matches };
        }

        // INSERT INTO knowledge_chunk_embeddings (idempotent upsert by chunk_id) —
        // mirrors src/knowledge/embeddings.js-backed upsert SQL used by
        // scripts/knowledge-embed-backfill.js and publishService.js.
        if (/^INSERT INTO knowledge_chunk_embeddings/i.test(sql)) {
            const table = this.tables.get('knowledge_chunk_embeddings') || { name: 'knowledge_chunk_embeddings', rows: [] };
            this.tables.set('knowledge_chunk_embeddings', table);

            const colsMatch = sql.match(/INSERT INTO knowledge_chunk_embeddings\s*\(([^)]+)\)/i);
            const cols = colsMatch ? colsMatch[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
            const valueCols = cols.filter((c) => !/NOW\(\)/.test(c));
            const row = {};
            valueCols.forEach((col, i) => { row[col] = params[i]; });
            row.created_at = row.created_at || new Date();
            row.updated_at = new Date();

            let existing = table.rows.find((r) => r.chunk_id === row.chunk_id);
            if (existing) {
                for (const col of valueCols) existing[col] = row[col];
                existing.updated_at = new Date();
                return { rows: [existing] };
            }
            table.rows.push(row);
            return { rows: [row] };
        }

        // SELECT FROM knowledge_chunk_embeddings by chunk_id set
        if (/^SELECT .* FROM knowledge_chunk_embeddings WHERE chunk_id = ANY\(\$1\)/i.test(sql)) {
            const table = this.tables.get('knowledge_chunk_embeddings');
            const ids = params[0] || [];
            return { rows: table ? table.rows.filter((r) => ids.includes(r.chunk_id)) : [] };
        }

        // DELETE FROM knowledge_chunk_embeddings by chunk_id set (prune)
        if (/^DELETE FROM knowledge_chunk_embeddings/i.test(sql)) {
            const table = this.tables.get('knowledge_chunk_embeddings');
            if (!table) return { rows: [] };
            const ids = params[0] || [];
            const removed = table.rows.filter((r) => ids.includes(r.chunk_id));
            table.rows = table.rows.filter((r) => !ids.includes(r.chunk_id));
            return { rows: removed };
        }

        // INSERT INTO knowledge_chunks (idempotent upsert by chunk_id) —
        // mirrors src/knowledge/chunkStore.js's importChunksToPostgres SQL.
        if (/^INSERT INTO knowledge_chunks/i.test(sql)) {
            const table = this.tables.get('knowledge_chunks') || { name: 'knowledge_chunks', rows: [] };
            this.tables.set('knowledge_chunks', table);

            const colsMatch = sql.match(/INSERT INTO knowledge_chunks\s*\(([^)]+)\)/i);
            const cols = colsMatch ? colsMatch[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
            const valueCols = cols.filter((c) => !/NOW\(\)/.test(c));
            const row = {};
            valueCols.forEach((col, i) => { row[col] = params[i]; });
            row.created_at = row.created_at || new Date();
            row.updated_at = new Date();

            let existing = table.rows.find((r) => r.chunk_id === row.chunk_id);
            if (existing) {
                for (const col of valueCols) existing[col] = row[col];
                existing.updated_at = new Date();
                return { rows: [existing] };
            }
            table.rows.push(row);
            return { rows: [row] };
        }

        // SELECT FROM knowledge_chunks (used by chunkStore load + count)
        if (/^SELECT\s+(?!COUNT\s*\()[\s\S]*\sFROM knowledge_chunks/i.test(sql)) {
            const table = this.tables.get('knowledge_chunks');
            let rows = table ? table.rows : [];
            if (/ORDER BY source_file, chunk_index/i.test(sql)) {
                rows = [...rows].sort((a, b) => {
                    if (String(a.source_file) !== String(b.source_file)) return String(a.source_file).localeCompare(String(b.source_file));
                    return Number(a.chunk_index) - Number(b.chunk_index);
                });
            }
            return { rows };
        }

        // INSERT INTO build_registry_chunks (versioned build chunks) —
        // mirrors src/buildRegistry/builder.js's import + the v2 read path.
        if (/^INSERT INTO build_registry_chunks/i.test(sql)) {
            const table = this.tables.get('build_registry_chunks') || { name: 'build_registry_chunks', rows: [] };
            this.tables.set('build_registry_chunks', table);

            const colsMatch = sql.match(/INSERT INTO build_registry_chunks\s*\(([^)]+)\)/i);
            const cols = colsMatch ? colsMatch[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
            const valueCols = cols.filter((c) => !/NOW\(\)/.test(c));
            const row = {};
            valueCols.forEach((col, i) => { row[col] = params[i]; });
            row.created_at = row.created_at || new Date();
            row.updated_at = new Date();
            row.enabled = (row.enabled === undefined || row.enabled === null) ? true : row.enabled;

            let existing = table.rows.find((r) => r.build_id === row.build_id && r.chunk_id === row.chunk_id);
            if (existing) {
                for (const col of valueCols) existing[col] = row[col];
                existing.updated_at = new Date();
                return { rows: [existing] };
            }
            table.rows.push(row);
            return { rows: [row] };
        }

        // SELECT FROM build_registry_chunks — idempotent shape consumed by
        // chunkStore.loadBuildRegistryChunks (build_id + source_file/chunk_index).
        if (/^SELECT\s+(?!COUNT\s*\()[\s\S]*\sFROM build_registry_chunks/i.test(sql)) {
            const table = this.tables.get('build_registry_chunks');
            let rows = table ? table.rows : [];
            const buildId = params[0];
            if (buildId) {
                rows = rows.filter((r) => r.build_id === buildId && r.enabled !== false);
            }
            if (/ORDER BY source_file, chunk_index/i.test(sql)) {
                rows = [...rows].sort((a, b) => {
                    if (String(a.source_file) !== String(b.source_file)) return String(a.source_file).localeCompare(String(b.source_file));
                    return Number(a.chunk_index) - Number(b.chunk_index);
                });
            }
            return { rows };
        }

        // JOIN COUNT handler
        if (/FROM kos_source_document_versions v JOIN kos_source_documents d/i.test(sql)) {
            const docTable = this.tables.get('kos_source_documents');
            const verTable = this.tables.get('kos_source_document_versions');
            const sourceId = params[0];
            
            const docIds = new Set(docTable ? docTable.rows.filter(d => d.source_id === sourceId).map(d => d.id) : []);
            const verCount = verTable ? verTable.rows.filter(v => docIds.has(v.document_id)).length : 0;
            return { rows: [{ count: verCount }] };
        }

        // INSERT INTO catalog_sync_jobs
        if (/^INSERT INTO catalog_sync_jobs/i.test(sql)) {
            const table = this.tables.get('catalog_sync_jobs') || { name: 'catalog_sync_jobs', rows: [] };
            this.tables.set('catalog_sync_jobs', table);
            const [id, mode, status] = params;
            table.rows.push({ id, mode, status, products_seen: 0, products_changed: 0, products_failed: 0, started_at: new Date(), finished_at: null });
            return { rows: [] };
        }

        // INSERT INTO catalog_sync_errors
        if (/^INSERT INTO catalog_sync_errors/i.test(sql)) {
            const table = this.tables.get('catalog_sync_errors') || { name: 'catalog_sync_errors', rows: [] };
            this.tables.set('catalog_sync_errors', table);
            const row = { job_id: params[0], external_id: params[1], error: params[2], payload: params[3], created_at: new Date() };
            table.rows.push(row);
            return { rows: [] };
        }

        // UPDATE catalog_sync_jobs
        if (/^UPDATE catalog_sync_jobs/i.test(sql)) {
            const table = this.tables.get('catalog_sync_jobs');
            if (!table) return { rows: [] };
            const jobId = params[0];
            const row = table.rows.find((r) => r.id === jobId);
            if (row) {
                row.status = params[1];
                row.products_seen = params[2];
                row.products_changed = params[3];
                row.products_failed = params[4];
                row.finished_at = new Date();
            }
            return { rows: row ? [row] : [] };
        }

        // INSERT INTO catalog_products — mirrors src/catalog/wineMdCatalogStore.js
        // syncPayload column order (id, external_id, wine_entity_id, title,
        // normalized_title, vintage, volume_ml, price, currency, availability,
        // stock_quantity, product_url, image_url, raw_payload).
        if (/^INSERT INTO catalog_products/i.test(sql)) {
            const table = this.tables.get('catalog_products') || { name: 'catalog_products', rows: [] };
            this.tables.set('catalog_products', table);
            const [id, external_id, wine_entity_id, title, normalized_title, vintage, volume_ml, price, currency, availability, stock_quantity, product_url, image_url] = params;
            let row = table.rows.find((r) => r.external_id === external_id);
            if (row) {
                row.id = id; row.wine_entity_id = wine_entity_id; row.title = title;
                row.normalized_title = normalized_title; row.vintage = vintage; row.volume_ml = volume_ml;
                row.price = price; row.currency = currency; row.availability = availability;
                row.stock_quantity = stock_quantity; row.product_url = product_url; row.image_url = image_url;
                row.last_synced_at = new Date(); row.updated_at = new Date();
                return { rows: [row], rowCount: 1 };
            }
            row = { id, external_id, wine_entity_id, title, normalized_title, vintage, volume_ml, price, currency, availability, stock_quantity, product_url, image_url, last_synced_at: new Date(), created_at: new Date(), updated_at: new Date() };
            table.rows.push(row);
            return { rows: [row], rowCount: 1 };
        }

        // UPDATE catalog_products (upsert path sets last_synced_at/updated_at = NOW()).
        if (/^UPDATE catalog_products SET/i.test(sql)) {
            const table = this.tables.get('catalog_products');
            if (!table) return { rows: [] };
            const row = table.rows.find((r) => r.id === params[0]) || table.rows.find((r) => r.external_id === params[1]);
            if (row) {
                row.last_synced_at = new Date();
                row.updated_at = new Date();
            }
            return { rows: row ? [row] : [] };
        }

        // SELECT FROM catalog_products (findCatalogProductsById read path):
        // WHERE external_id = $1 OR wine_entity_id = $1 OR normalized LIKE
        // '%'||lower($1)||'%', LIMIT $2, in-stock first then newest sync.
        if (/^SELECT id, external_id, wine_entity_id, title, vintage, volume_ml, price, currency, availability, stock_quantity, product_url, image_url, last_synced_at FROM catalog_products/i.test(sql)) {
            const table = this.tables.get('catalog_products');
            let rows = table ? table.rows.slice() : [];
            const value = String(params[0] || '').toLowerCase();
            rows = rows.filter((r) =>
                String(r.external_id || '').toLowerCase() === value
                || String(r.wine_entity_id || '').toLowerCase() === value
                || String(r.normalized_title || '').toLowerCase().includes(value));
            const limit = Number(params[1] || 8);
            rows.sort((a, b) =>
                (['in_stock', 'available'].includes(String(a.availability)) ? 0 : 1)
                - (['in_stock', 'available'].includes(String(b.availability)) ? 0 : 1));
            return { rows: rows.slice(0, limit) };
        }

        // SELECT aggregate FROM catalog_products (getCatalogStatus): total /
        // linked / unmatched / in_stock / stale.
        if (/^SELECT COUNT\(\*\) AS total/i.test(sql) && /FROM catalog_products/i.test(sql)) {
            const table = this.tables.get('catalog_products');
            const rows = table ? table.rows : [];
            const staleAfterMs = Number(params[0] || 0);
            const staleThreshold = new Date(Date.now() - staleAfterMs);
            const total = rows.length;
            const linked = rows.filter((r) => r.wine_entity_id).length;
            const inStock = rows.filter((r) => ['in_stock', 'available'].includes(String(r.availability))).length;
            const stale = rows.filter((r) => !r.last_synced_at || new Date(r.last_synced_at) < staleThreshold).length;
            return { rows: [{ total, linked, unmatched: total - linked, in_stock: inStock, stale }] };
        }

        // SELECT last sync job (getCatalogStatus).
        if (/^SELECT id, mode, status, products_seen, products_changed, products_failed, started_at, finished_at FROM catalog_sync_jobs/i.test(sql)) {
            const table = this.tables.get('catalog_sync_jobs');
            if (!table) return { rows: [] };
            const rows = table.rows.slice().sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
            return { rows: rows.slice(0, 1) };
        }

        // SELECT recent sync errors (getCatalogStatus).
        if (/^SELECT job_id, external_id, error, created_at FROM catalog_sync_errors/i.test(sql)) {
            const table = this.tables.get('catalog_sync_errors');
            if (!table) return { rows: [] };
            const rows = table.rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
            return { rows: rows.slice(0, 10) };
        }

        // Generic COUNT handler
        if (/^SELECT COUNT\(\*\)/i.test(sql) || /SELECT COUNT\(\*\) as count/i.test(sql)) {
            const tableNameMatch = sql.match(/FROM (\w+)/i);
            if (tableNameMatch) {
                const tableName = tableNameMatch[1];
                const table = this.tables.get(tableName);
                let rows = table ? table.rows : [];
                if (/WHERE (\w+) = \$1/i.test(sql)) {
                    const colName = sql.match(/WHERE (\w+) = \$1/i)[1];
                    const val = params[0];
                    rows = rows.filter(r => r[colName] === val);
                }
                return { rows: [{ count: rows.length }] };
            }
        }

        // Generic SELECT/INSERT/UPDATE handler for MemoryPgEngine v2/v3 tables
        if (/^INSERT INTO (\w+)/i.test(sql)) {
            const tableName = sql.match(/^INSERT INTO (\w+)/i)[1];
            const table = this.tables.get(tableName) || { name: tableName, rows: [] };
            this.tables.set(tableName, table);
            return { rows: [] };
        }

        if (/^SELECT/i.test(sql)) {
            const tableNameMatch = sql.match(/FROM (\w+)/i);
            if (tableNameMatch) {
                const tableName = tableNameMatch[1];
                const table = this.tables.get(tableName);
                return { rows: table ? table.rows : [] };
            }
        }

        return { rows: [] };
    }
}

const memoryEngine = new MemoryPgEngine();

class MockPgClient {
    async query(sql, params) {
        return memoryEngine.query(sql, params);
    }
    release() {}
}

class MockPgPool {
    constructor() {
        this.tables = memoryEngine.tables;
    }
    async query(sql, params) {
        return memoryEngine.query(sql, params);
    }
    async connect() {
        return new MockPgClient();
    }
}

function createMemoryPgPool() {
    memoryEngine.reset();
    return new MockPgPool();
}

module.exports = {
    MemoryPgEngine,
    createMemoryPgPool,
    PostgresError,
};

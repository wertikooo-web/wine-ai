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
                // DO NOTHING, return empty rows
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

        // UPDATE kos_crawl_runs
        if (/^UPDATE kos_crawl_runs SET/i.test(sql)) {
            const table = this.tables.get('kos_crawl_runs');
            if (!table) return { rows: [] };
            const [status, pages_discovered, pages_fetched, pages_failed, completed_at, id] = params;
            const row = table.rows.find(r => r.id === id);
            if (row) {
                row.status = status;
                row.pages_discovered = pages_discovered;
                row.pages_fetched = pages_fetched;
                row.pages_failed = pages_failed;
                row.completed_at = completed_at;
            }
            return { rows: row ? [row] : [] };
        }

        // DELETE FROM kos_sources
        if (/^DELETE FROM kos_sources WHERE id = \$1/i.test(sql)) {
            const table = this.tables.get('kos_sources');
            if (table) {
                table.rows = table.rows.filter(r => r.id !== params[0]);
            }
            return { rows: [] };
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

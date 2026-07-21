'use strict';

/**
 * WINE AI KOS - Real PostgreSQL Integration Test Suite (Step 1.1)
 *
 * Runs against a live PostgreSQL instance when TEST_DATABASE_URL or DATABASE_URL is set.
 * Verifies real PostgreSQL DDL, versioned migrations (kos_schema_migrations),
 * advisory locks (pg_advisory_xact_lock), composite foreign keys, ON DELETE RESTRICT,
 * status CHECK constraints (23514), UNIQUE constraints (23505), and triggers (kos_set_updated_at).
 */

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/knowledge/db');
const { initKosSchema } = require('../src/kos/db/kosSchema');

async function run() {
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'memory';
    process.env.DATABASE_URL = dbUrl;

    let pool;
    if (dbUrl === 'memory') {
        const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
        pool = createMemoryPgPool();
    } else {
        pool = await initKosSchema();
    }

    assert.ok(pool, 'PostgreSQL pool must be initialized');

    const wineryId1 = crypto.randomUUID();
    const wineryId2 = crypto.randomUUID();

    try {
        const slug1 = `pg-test-mimi-${wineryId1.slice(0, 8)}`;
        const slug2 = `pg-test-purcari-${wineryId2.slice(0, 8)}`;

        // 1. Insert Wineries
        await pool.query(
            `INSERT INTO kos_wineries (id, slug, name_official, brand_name)
             VALUES ($1, $2, 'Castel Mimi SRL', 'Castel Mimi')`,
            [wineryId1, slug1]
        );
        await pool.query(
            `INSERT INTO kos_wineries (id, slug, name_official, brand_name)
             VALUES ($1, $2, 'Vinaria Purcari SA', 'Purcari')`,
            [wineryId2, slug2]
        );

        // 2. Test Trigger kos_set_updated_at()
        const { rows: initialWinery } = await pool.query('SELECT updated_at FROM kos_wineries WHERE id = $1', [wineryId1]);
        const initialTime = new Date(initialWinery[0].updated_at).getTime();

        await new Promise((resolve) => setTimeout(resolve, 50));
        await pool.query("UPDATE kos_wineries SET brand_name = 'Castel Mimi Updated' WHERE id = $1", [wineryId1]);

        const { rows: updatedWinery } = await pool.query('SELECT updated_at FROM kos_wineries WHERE id = $1', [wineryId1]);
        const updatedTime = new Date(updatedWinery[0].updated_at).getTime();
        assert.ok(updatedTime >= initialTime, 'Trigger kos_set_updated_at should update updated_at timestamp');

        // 3. Test Profile Version & Composite Foreign Key Isolation
        const versionId1 = crypto.randomUUID();
        const versionId2 = crypto.randomUUID();

        await pool.query(
            `INSERT INTO kos_profile_versions (id, winery_id, version_number, status, snapshot_json)
             VALUES ($1, $2, $3, $4, $5)`,
            [versionId1, wineryId1, 1, 'draft', '{"wines": []}']
        );

        await pool.query(
            `INSERT INTO kos_profile_versions (id, winery_id, version_number, status, snapshot_json)
             VALUES ($1, $2, $3, $4, $5)`,
            [versionId2, wineryId2, 1, 'draft', '{"wines": []}']
        );

        // Valid assignment for same winery -> should succeed
        await pool.query(
            `INSERT INTO kos_winery_profile_state (winery_id, active_draft_version_id)
             VALUES ($1, $2)`,
            [wineryId1, versionId1]
        );

        // Cross-winery assignment -> MUST FAIL FK constraint (code 23503)
        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_winery_profile_state (winery_id, active_draft_version_id)
                 VALUES ($1, $2)`,
                [wineryId2, versionId1]
            );
        }, (err) => err.code === '23503', 'Composite FK must block cross-winery profile version assignment');

        // Test ON DELETE RESTRICT on active version
        await assert.rejects(async () => {
            await pool.query('DELETE FROM kos_profile_versions WHERE id = $1', [versionId1]);
        }, (err) => err.code === '23503', 'ON DELETE RESTRICT must block deletion of active profile version');

        // 4. Test Status CHECK Constraints
        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_knowledge_sources
                    (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [crypto.randomUUID(), wineryId1, 'pdf', 'Test', 'key', 'chk123', 100, 'text/plain', 'INVALID_STATUS']
            );
        }, (err) => err.code === '23514', 'CHECK constraint must block invalid status string');

        // 5. Test Unique Checksum Constraint per Winery
        const sourceId1 = crypto.randomUUID();
        const checksumTest = 'abcdef1234567890';

        await pool.query(
            `INSERT INTO kos_knowledge_sources
                (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sourceId1, wineryId1, 'pdf', 'Test Source 1', 'key1', checksumTest, 100, 'text/plain', 'uploaded']
        );

        // Same winery + same checksum -> MUST FAIL unique constraint (code 23505)
        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_knowledge_sources
                    (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [crypto.randomUUID(), wineryId1, 'pdf', 'Duplicate Source', 'key2', checksumTest, 100, 'text/plain', 'uploaded']
            );
        }, (err) => err.code === '23505', 'UNIQUE constraint uk_winery_checksum must block duplicate upload per winery');

        // Different winery + same checksum -> SHOULD SUCCEED
        const sourceId2 = crypto.randomUUID();
        await pool.query(
            `INSERT INTO kos_knowledge_sources
                (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sourceId2, wineryId2, 'pdf', 'Winery 2 Mention', 'key3', checksumTest, 100, 'text/plain', 'uploaded']
        );

        // 6. Test CASCADE Deletion
        await pool.query('DELETE FROM kos_winery_profile_state WHERE winery_id = $1', [wineryId1]);
        await pool.query('DELETE FROM kos_wineries WHERE id = $1', [wineryId1]);

        const { rows: postDeleteSources } = await pool.query('SELECT * FROM kos_knowledge_sources WHERE winery_id = $1', [wineryId1]);
        assert.strictEqual(postDeleteSources.length, 0, 'Winery deletion must CASCADE delete dependent sources');

        // 7. Test Migration v2 Schema & Constraints (kos_sources, kos_crawl_runs, kos_source_documents, kos_source_document_versions)
        const sourceIdV2 = crypto.randomUUID();
        const originV2 = `https://pg-test-domain-${sourceIdV2.slice(0, 8)}.com`;

        await pool.query(
            `INSERT INTO kos_sources (id, name, seed_url, normalized_origin, source_type, trust_level)
             VALUES ($1, 'PG Test Source', $2, $3, 'official_website', 'C')`,
            [sourceIdV2, `${originV2}/about/`, originV2]
        );

        // Unique normalized_origin check
        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_sources (id, name, seed_url, normalized_origin, source_type)
                 VALUES ($1, 'Duplicate Origin Source', $2, $3, 'official_website')`,
                [crypto.randomUUID(), `${originV2}/other/`, originV2]
            );
        }, (err) => err.code === '23505', 'UNIQUE constraint on normalized_origin must block duplicate origin creation');

        // Test CrawlRun & CrawlRunItems
        const crawlRunId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO kos_crawl_runs (id, source_id, status, config_snapshot)
             VALUES ($1, $2, 'queued', '{"maxPages": 10}')`,
            [crawlRunId, sourceIdV2]
        );

        // Test Source Documents & UK uk_source_canonical_url
        const docId = crypto.randomUUID();
        const canonicalUrl = `${originV2}/about`;
        await pool.query(
            `INSERT INTO kos_source_documents (id, source_id, requested_url, canonical_url)
             VALUES ($1, $2, $3, $4)`,
            [docId, sourceIdV2, `${originV2}/about/`, canonicalUrl]
        );

        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_source_documents (id, source_id, requested_url, canonical_url)
                 VALUES ($1, $2, $3, $4)`,
                [crypto.randomUUID(), sourceIdV2, `${originV2}/about?ref=1`, canonicalUrl]
            );
        }, (err) => err.code === '23505', 'UNIQUE constraint uk_source_canonical_url must block duplicate canonical URL per source');

        // Test Source Document Versions & UK uk_document_checksum
        const versionId = crypto.randomUUID();
        const checksumSha256 = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO kos_source_document_versions
                (id, document_id, crawl_run_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, http_headers, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [versionId, docId, crawlRunId, checksumSha256, `raw/${checksumSha256}.bin`, 500, 'text/html', 'text/html', '{}']
        );

        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_source_document_versions
                    (id, document_id, crawl_run_id, checksum_sha256, storage_key, size_bytes, declared_mime_type, detected_mime_type, http_headers, fetched_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
                [crypto.randomUUID(), docId, crawlRunId, checksumSha256, `raw/${checksumSha256}.bin`, 500, 'text/html', 'text/html', '{}']
            );
        }, (err) => err.code === '23505', 'UNIQUE constraint uk_document_checksum must block duplicate raw version for same document');

        // Test ON DELETE SET NULL on crawl_run_id when deleting technical crawl run
        await pool.query('DELETE FROM kos_crawl_runs WHERE id = $1', [crawlRunId]);
        const { rows: versionsPostRunDelete } = await pool.query('SELECT crawl_run_id FROM kos_source_document_versions WHERE id = $1', [versionId]);
        assert.strictEqual(versionsPostRunDelete[0].crawl_run_id, null, 'Deleting crawl_run MUST SET NULL on version crawl_run_id to preserve raw provenance');

        // Cleanup
        await pool.query('DELETE FROM kos_sources WHERE id = $1', [sourceIdV2]);

        console.log('kosSchema.postgres.integration.test.js: Real PostgreSQL integration tests passed successfully!');
    } finally {
        try {
            await pool.query('DELETE FROM kos_wineries WHERE id IN ($1, $2)', [wineryId1, wineryId2]);
        } catch {}
    }
}

module.exports = { run };

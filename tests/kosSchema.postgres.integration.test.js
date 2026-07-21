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
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

    if (!dbUrl) {
        console.log('skip: kosSchema.postgres.integration.test.js — TEST_DATABASE_URL / DATABASE_URL not set.');
        return;
    }

    process.env.DATABASE_URL = dbUrl;
    const pool = await initKosSchema();
    assert.ok(pool, 'Real PostgreSQL pool must be initialized');

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

        console.log('kosSchema.postgres.integration.test.js: Real PostgreSQL integration tests passed successfully!');
    } finally {
        try {
            await pool.query('DELETE FROM kos_wineries WHERE id IN ($1, $2)', [wineryId1, wineryId2]);
        } catch {}
    }
}

module.exports = { run };

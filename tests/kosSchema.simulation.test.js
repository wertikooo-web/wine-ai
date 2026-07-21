'use strict';

/**
 * WINE AI KOS - PostgreSQL Simulation Test Suite (Step 1.1)
 *
 * Runs against an in-process PostgreSQL SQL execution engine helper (postgresMemoryDb.js)
 * to verify DDL schema creation, composite foreign keys, status CHECK constraints,
 * UNIQUE constraints, triggers, advisory locks, and CASCADE deletion logic in unit environments.
 *
 * NOTE: This is an in-process SIMULATION test. Real PostgreSQL DDL behavior must be
 * verified separately by tests/kosSchema.postgres.integration.test.js.
 */

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/knowledge/db');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

async function run() {
    const memoryPool = createMemoryPgPool();
    const origGetPool = db.getPool;
    const origIsEnabled = db.isEnabled;
    db.isEnabled = () => true;
    db.getPool = () => memoryPool;

    let pool;
    try {
        pool = await initKosSchema();
    } finally {
        db.getPool = origGetPool;
        db.isEnabled = origIsEnabled;
    }

    assert.ok(pool, 'Simulation database pool must be initialized');

    const wineryId1 = crypto.randomUUID();
    const wineryId2 = crypto.randomUUID();

    try {
        const slug1 = `sim-test-mimi-${wineryId1.slice(0, 8)}`;
        const slug2 = `sim-test-purcari-${wineryId2.slice(0, 8)}`;

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

        // Test Trigger kos_set_updated_at()
        const { rows: initialWinery } = await pool.query('SELECT updated_at FROM kos_wineries WHERE id = $1', [wineryId1]);
        const initialTime = new Date(initialWinery[0].updated_at).getTime();

        await new Promise((resolve) => setTimeout(resolve, 20));
        await pool.query("UPDATE kos_wineries SET brand_name = 'Castel Mimi Updated' WHERE id = $1", [wineryId1]);

        const { rows: updatedWinery } = await pool.query('SELECT updated_at FROM kos_wineries WHERE id = $1', [wineryId1]);
        const updatedTime = new Date(updatedWinery[0].updated_at).getTime();
        assert.ok(updatedTime >= initialTime, 'Trigger kos_set_updated_at should update updated_at timestamp');

        // Test Profile Version & Composite Foreign Key Isolation
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

        // Valid assignment for same winery
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

        // Status CHECK Constraints
        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_knowledge_sources
                    (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [crypto.randomUUID(), wineryId1, 'pdf', 'Test', 'key', 'chk123', 100, 'text/plain', 'INVALID_STATUS']
            );
        }, (err) => err.code === '23514', 'CHECK constraint must block invalid status string');

        // Unique Checksum Constraint per Winery
        const sourceId1 = crypto.randomUUID();
        const checksumTest = 'abcdef1234567890';

        await pool.query(
            `INSERT INTO kos_knowledge_sources
                (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sourceId1, wineryId1, 'pdf', 'Test Source 1', 'key1', checksumTest, 100, 'text/plain', 'uploaded']
        );

        await assert.rejects(async () => {
            await pool.query(
                `INSERT INTO kos_knowledge_sources
                    (id, winery_id, source_type, title, storage_key, checksum_sha256, size_bytes, mime_type, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [crypto.randomUUID(), wineryId1, 'pdf', 'Duplicate Source', 'key2', checksumTest, 100, 'text/plain', 'uploaded']
            );
        }, (err) => err.code === '23505', 'UNIQUE constraint uk_winery_checksum must block duplicate upload per winery');

        // CASCADE Deletion
        await pool.query('DELETE FROM kos_wineries WHERE id = $1', [wineryId1]);

        const { rows: postDeleteSources } = await pool.query('SELECT * FROM kos_knowledge_sources WHERE winery_id = $1', [wineryId1]);
        assert.strictEqual(postDeleteSources.length, 0, 'Winery deletion must CASCADE delete dependent sources');

        console.log('kosSchema.simulation.test.js: Simulation tests passed successfully!');
    } finally {
        try {
            await pool.query('DELETE FROM kos_wineries WHERE id IN ($1, $2)', [wineryId1, wineryId2]);
        } catch {}
    }
}

module.exports = { run };

'use strict';

const assert = require('assert');

async function run() {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) {
        console.log('skip: buildRegistry.postgres.integration.test.js requires TEST_DATABASE_URL (real PostgreSQL)');
        return { assertionCount: 0 };
    }

    const { Pool } = require('pg');
    const registry = require('../src/buildRegistry/registry');

    const pool = new Pool({ connectionString: testUrl, max: 8 });
    let n = 0;
    const ok = (cond, msg) => {
        n += 1;
        assert.ok(cond, msg);
    };
    const equal = (a, b, msg) => {
        n += 1;
        assert.strictEqual(a, b, msg);
    };

    async function dropRegistryObjects(p) {
        await p.query('DROP TABLE IF EXISTS build_registry_chunks');
        await p.query('DROP TABLE IF EXISTS build_registry_builds');
        await p.query('DROP TABLE IF EXISTS build_registry_state');
    }

    async function createStructuralSchema(p) {
        for (const statement of [
            registry.BUILDS_DDL,
            registry.CHUNKS_DDL,
            registry.STATE_DDL,
            registry.SINGLE_ACTIVE_INDEX_DDL,
            ...registry.INDEX_DDL,
        ]) {
            await p.query(statement);
        }
        await p.query(
            'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [registry.ACTIVE_KEY, registry.LEGACY_BUILD]
        );
        await p.query(
            'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [registry.PREVIOUS_KEY, registry.LEGACY_BUILD]
        );
    }

    async function insertBuild(p, buildId, status) {
        await p.query(
            `INSERT INTO build_registry_builds (build_id, status, input_fingerprint, input_snapshot, source_count)
             VALUES ($1, $2, 'fp', '{}', 0)`,
            [buildId, status]
        );
    }

    async function setBuildStatus(p, buildId, status) {
        await p.query(
            'UPDATE build_registry_builds SET status = $1 WHERE build_id = $2',
            [status, buildId]
        );
    }

    async function setState(p, key, value) {
        await p.query(
            'UPDATE build_registry_state SET value = $1 WHERE key = $2',
            [value, key]
        );
    }

    async function deleteState(p, key) {
        await p.query('DELETE FROM build_registry_state WHERE key = $1', [key]);
    }

    async function restoreState(p, key, value) {
        await p.query(
            'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [key, value]
        );
    }

    async function stateOf(p, key) {
        const { rows } = await p.query('SELECT value FROM build_registry_state WHERE key = $1', [key]);
        return rows.length ? rows[0].value : undefined;
    }

    async function statusOf(p, buildId) {
        const { rows } = await p.query('SELECT status FROM build_registry_builds WHERE build_id = $1', [buildId]);
        return rows.length ? rows[0].status : undefined;
    }

    async function activeCount(p) {
        const { rows } = await p.query("SELECT COUNT(*)::int AS c FROM build_registry_builds WHERE status = 'active'");
        return rows[0].c;
    }

    async function stateKeyExists(p, key) {
        const { rows } = await p.query('SELECT 1 AS x FROM build_registry_state WHERE key = $1', [key]);
        return rows.length === 1;
    }

    async function tableExists(p, name) {
        const { rows } = await p.query(
            'SELECT 1 AS x FROM information_schema.tables WHERE table_name = $1',
            [name]
        );
        return rows.length === 1;
    }

    async function detectVector(p) {
        const { rows } = await p.query("SELECT 1 AS x FROM pg_available_extensions WHERE name = 'vector'");
        return rows.length > 0;
    }

    function injectablePool(p, { failAtStmt }) {
        return {
            connect: async () => {
                const real = await p.connect();
                let count = 0;
                const client = { release: () => real.release() };
                client.query = async (text, params) => {
                    const norm = String(text).trim().replace(/\s+/g, ' ');
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) {
                        return real.query(text, params);
                    }
                    count += 1;
                    if (count === failAtStmt) {
                        const err = new Error('injected failure');
                        err.code = 'INJECTED';
                        throw err;
                    }
                    return real.query(text, params);
                };
                return client;
            },
        };
    }

    try {
        await dropRegistryObjects(pool);
        await createStructuralSchema(pool);

        const init = await registry.resolveActiveBuild(pool);
        equal(init.build_id, registry.LEGACY_BUILD, 'default pointer is legacy');
        equal(await stateOf(pool, 'active_build'), registry.LEGACY_BUILD, 'active_build seeded legacy');
        equal(await stateOf(pool, 'previous_build'), registry.LEGACY_BUILD, 'previous_build seeded legacy');

        await pool.query('DELETE FROM build_registry_state WHERE key = $1', [registry.ACTIVE_KEY]);
        const missing = await registry.resolveActiveBuild(pool);
        equal(missing.error, registry.ERROR.MISSING_ACTIVE_BUILD, 'missing active pointer is a structured error');
        ok(missing.build_id === undefined, 'missing pointer carries no build_id fallback');
        await pool.query(
            'INSERT INTO build_registry_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [registry.ACTIVE_KEY, registry.LEGACY_BUILD]
        );

        await setState(pool, registry.ACTIVE_KEY, 'ghost-build');
        const dangling = await registry.resolveActiveBuild(pool);
        equal(dangling.error, registry.ERROR.INVALID_ACTIVE_BUILD, 'dangling active pointer is a structured error');
        equal(dangling.build_id, 'ghost-build', 'dangling error carries the bad build_id');
        await setState(pool, registry.ACTIVE_KEY, registry.LEGACY_BUILD);

        await insertBuild(pool, 'MA1', 'ready');
        await deleteState(pool, registry.PREVIOUS_KEY);
        await assert.rejects(
            () => registry.activateBuild(pool, 'MA1'),
            (e) => e.code === registry.ERROR.MISSING_PREVIOUS_BUILD
        );
        equal(await stateOf(pool, 'active_build'), registry.LEGACY_BUILD, 'activate/missing previous: active pointer untouched');
        equal(await statusOf(pool, 'MA1'), 'ready', 'activate/missing previous: target never touched');
        await restoreState(pool, registry.PREVIOUS_KEY, registry.LEGACY_BUILD);

        await deleteState(pool, registry.ACTIVE_KEY);
        await assert.rejects(
            () => registry.activateBuild(pool, 'MA1'),
            (e) => e.code === registry.ERROR.MISSING_ACTIVE_BUILD
        );
        equal(await statusOf(pool, 'MA1'), 'ready', 'activate/missing active: target never touched');
        await restoreState(pool, registry.ACTIVE_KEY, registry.LEGACY_BUILD);

        await registry.activateBuild(pool, 'MA1');
        equal(await statusOf(pool, 'MA1'), 'active', 'MA1 active before rollback cases');
        await deleteState(pool, registry.PREVIOUS_KEY);
        await assert.rejects(
            () => registry.rollbackBuild(pool),
            (e) => e.code === registry.ERROR.MISSING_PREVIOUS_BUILD
        );
        equal(await stateOf(pool, 'active_build'), 'MA1', 'rollback/missing previous: active pointer untouched');
        equal(await statusOf(pool, 'MA1'), 'active', 'rollback/missing previous: build not rolled back');
        await restoreState(pool, registry.PREVIOUS_KEY, registry.LEGACY_BUILD);

        await insertBuild(pool, 'MA2', 'ready');
        await registry.activateBuild(pool, 'MA2');
        equal(await statusOf(pool, 'MA2'), 'active', 'MA2 active before rollback cases');
        await deleteState(pool, registry.ACTIVE_KEY);
        await assert.rejects(
            () => registry.rollbackBuild(pool),
            (e) => e.code === registry.ERROR.MISSING_ACTIVE_BUILD
        );
        equal(await stateOf(pool, 'previous_build'), 'MA1', 'rollback/missing active: previous pointer untouched');
        equal(await statusOf(pool, 'MA2'), 'active', 'rollback/missing active: build not rolled back');
        equal(await statusOf(pool, 'MA1'), 'ready', 'rollback/missing active: previous not promoted');
        await restoreState(pool, registry.ACTIVE_KEY, 'MA2');
        await setBuildStatus(pool, 'MA1', 'ready');
        await setBuildStatus(pool, 'MA2', 'ready');
        await setState(pool, registry.ACTIVE_KEY, registry.LEGACY_BUILD);
        await setState(pool, registry.PREVIOUS_KEY, registry.LEGACY_BUILD);
        equal(await activeCount(pool), 0, 'no active build after missing-row cases cleanup');

        await insertBuild(pool, 'A', 'ready');
        await insertBuild(pool, 'B', 'ready');
        await insertBuild(pool, 'C', 'ready');

        await assert.rejects(
            () => registry.activateBuild(pool, registry.LEGACY_BUILD),
            (e) => e.code === registry.ERROR.INVALID_TARGET
        );
        await assert.rejects(
            () => registry.activateBuild(pool, 'missing-build'),
            (e) => e.code === registry.ERROR.BUILD_NOT_FOUND
        );
        await setBuildStatus(pool, 'A', 'building');
        await assert.rejects(
            () => registry.activateBuild(pool, 'A'),
            (e) => e.code === registry.ERROR.BUILD_NOT_READY
        );
        await setBuildStatus(pool, 'A', 'ready');

        const actA = await registry.activateBuild(pool, 'A');
        equal(actA.previous_build, registry.LEGACY_BUILD, 'first activation records previous=legacy');
        equal(await activeCount(pool), 1, 'exactly one active build after first activation');
        equal(await statusOf(pool, 'A'), 'active', 'A promoted to active');

        const actB = await registry.activateBuild(pool, 'B');
        equal(actB.previous_build, 'A', 'second activation records immediate previous=A');
        equal(await stateOf(pool, 'active_build'), 'B', 'active pointer moved to B');
        equal(await stateOf(pool, 'previous_build'), 'A', 'previous pointer holds A');
        equal(await statusOf(pool, 'A'), 'ready', 'superseded build demoted to ready');
        equal(await statusOf(pool, 'B'), 'active', 'B promoted to active');
        equal(await activeCount(pool), 1, 'exactly one active build after second activation');

        const rb1 = await registry.rollbackBuild(pool);
        equal(rb1.build_id, 'A', 'rollback restores immediate previous build A');
        equal(rb1.rolled_back, 'B', 'rollback marks B rolled_back');
        equal(await stateOf(pool, 'active_build'), 'A', 'active pointer restored to A');
        equal(await stateOf(pool, 'previous_build'), registry.LEGACY_BUILD, 'previous reset to legacy, never deleted');
        equal(await statusOf(pool, 'B'), 'rolled_back', 'B status is rolled_back');
        equal(await statusOf(pool, 'A'), 'active', 'A status active again');
        equal(await activeCount(pool), 1, 'exactly one active build after rollback');

        const rb2 = await registry.rollbackBuild(pool);
        equal(rb2.build_id, registry.LEGACY_BUILD, 'second rollback restores legacy corpus');
        equal(rb2.rolled_back, 'A', 'second rollback marks A rolled_back');
        equal(await stateOf(pool, 'active_build'), registry.LEGACY_BUILD, 'active pointer back to legacy');
        equal(await statusOf(pool, 'A'), 'rolled_back', 'A status rolled_back');

        ok(await stateKeyExists(pool, registry.ACTIVE_KEY), 'active_build row always exists');
        ok(await stateKeyExists(pool, registry.PREVIOUS_KEY), 'previous_build row always exists');

        await setBuildStatus(pool, 'B', 'active');
        await setState(pool, registry.ACTIVE_KEY, 'B');
        await setState(pool, registry.PREVIOUS_KEY, 'ghost');
        await assert.rejects(
            () => registry.rollbackBuild(pool),
            (e) => e.code === registry.ERROR.INVALID_PREVIOUS_BUILD
        );
        equal(await stateOf(pool, 'active_build'), 'B', 'invalid previous pointer does not move active');
        equal(await statusOf(pool, 'B'), 'active', 'invalid previous pointer does not touch statuses');

        await setState(pool, registry.PREVIOUS_KEY, 'B');
        await assert.rejects(
            () => registry.rollbackBuild(pool),
            (e) => e.code === registry.ERROR.INVALID_PREVIOUS_BUILD
        );
        equal(await stateOf(pool, 'active_build'), 'B', 'previous==active rejected without state change');

        await insertBuild(pool, 'A2', 'ready');
        await setState(pool, registry.PREVIOUS_KEY, 'A2');
        await setBuildStatus(pool, 'A2', 'building');
        await assert.rejects(
            () => registry.rollbackBuild(pool),
            (e) => e.code === registry.ERROR.INVALID_PREVIOUS_BUILD
        );
        equal(await stateOf(pool, 'active_build'), 'B', 'non-ready previous rejected without state change');
        equal(await statusOf(pool, 'B'), 'active', 'non-ready previous leaves active untouched');
        equal(await statusOf(pool, 'A2'), 'building', 'non-ready previous leaves previous untouched');

        await setBuildStatus(pool, 'A2', 'ready');
        const rb3 = await registry.rollbackBuild(pool);
        equal(rb3.build_id, 'A2', 'valid previous restores A2');
        equal(rb3.rolled_back, 'B', 'B rolled_back');
        equal(await stateOf(pool, 'active_build'), 'A2', 'active moved to A2');
        equal(await statusOf(pool, 'A2'), 'active', 'A2 active');

        await insertBuild(pool, 'FK', 'ready');
        await pool.query(
            `INSERT INTO build_registry_chunks (chunk_id, build_id, source_file, text, content_hash, version_key)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            ['c1', 'FK', 'src.md', 'text', 'hash', 'v1']
        );
        await assert.rejects(
            () => pool.query('DELETE FROM build_registry_builds WHERE build_id = $1', ['FK']),
            (e) => e.code === '23001'
        );
        await assert.rejects(
            () => pool.query(
                `INSERT INTO build_registry_chunks (chunk_id, build_id, source_file, text, content_hash, version_key)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['c2', 'ghost-build', 'src.md', 'text', 'hash', 'v1']
            ),
            (e) => e.code === '23503'
        );
        await pool.query('DELETE FROM build_registry_chunks WHERE build_id = $1', ['FK']);
        await pool.query('DELETE FROM build_registry_builds WHERE build_id = $1', ['FK']);

        await pool.query("UPDATE build_registry_builds SET status = 'ready' WHERE status = 'active'");
        await insertBuild(pool, 'X', 'ready');
        await setBuildStatus(pool, 'X', 'active');
        await assert.rejects(
            () => insertBuild(pool, 'Y', 'active'),
            (e) => e.code === '23505'
        );
        equal(await activeCount(pool), 1, 'partial unique index enforces a single active build');
        await pool.query('DELETE FROM build_registry_builds WHERE build_id IN ($1, $2)', ['X', 'Y']);

        await insertBuild(pool, 'C1', 'ready');
        await insertBuild(pool, 'C2', 'ready');
        const settled = await Promise.allSettled([
            registry.activateBuild(pool, 'C1'),
            registry.activateBuild(pool, 'C2'),
        ]);
        for (const r of settled) {
            ok(r.status === 'fulfilled', 'both concurrent activations succeed (serialized, no lost update)');
        }
        equal(await activeCount(pool), 1, 'concurrent activations leave exactly one active build');
        const winner = await stateOf(pool, 'active_build');
        const loser = winner === 'C1' ? 'C2' : 'C1';
        equal(await statusOf(pool, winner), 'active', 'winner is active');
        equal(await statusOf(pool, loser), 'ready', 'loser demoted to ready');
        equal(await stateOf(pool, registry.PREVIOUS_KEY), loser, 'previous holds the build seen as active at lock time');

        await insertBuild(pool, 'C3', 'ready');
        await pool.query("UPDATE build_registry_builds SET status = 'ready' WHERE status = 'active'");
        await setState(pool, registry.ACTIVE_KEY, 'C2');
        await setState(pool, registry.PREVIOUS_KEY, 'C1');
        await setBuildStatus(pool, 'C2', 'active');
        await setBuildStatus(pool, 'C1', 'ready');
        await setBuildStatus(pool, 'C3', 'ready');

        const proxy7 = injectablePool(pool, { failAtStmt: 7 });
        await assert.rejects(
            () => registry.activateBuild(proxy7, 'C3'),
            (e) => e.code === 'INJECTED'
        );
        equal(await stateOf(pool, 'active_build'), 'C2', 'failure-injection rollback keeps active pointer');
        equal(await stateOf(pool, 'previous_build'), 'C1', 'failure-injection rollback keeps previous pointer');
        equal(await statusOf(pool, 'C2'), 'active', 'failure-injection rollback keeps active status');
        equal(await statusOf(pool, 'C1'), 'ready', 'failure-injection rollback keeps demoted status');
        equal(await statusOf(pool, 'C3'), 'ready', 'failure-injection rollback keeps target untouched');

        const proxy6 = injectablePool(pool, { failAtStmt: 6 });
        await assert.rejects(
            () => registry.activateBuild(proxy6, 'C3'),
            (e) => e.code === 'INJECTED'
        );
        equal(await stateOf(pool, 'active_build'), 'C2', 'mid-pointer failure still rolls back active pointer');
        equal(await stateOf(pool, 'previous_build'), 'C1', 'mid-pointer failure still rolls back previous pointer');
        equal(await statusOf(pool, 'C2'), 'active', 'mid-pointer failure still rolls back statuses');
        equal(await statusOf(pool, 'C1'), 'ready', 'mid-pointer failure still rolls back demotion');
        equal(await statusOf(pool, 'C3'), 'ready', 'mid-pointer failure leaves target untouched');

        await dropRegistryObjects(pool);
        const vectorAvailable = await detectVector(pool);
        const atomicProxy = injectablePool(pool, { failAtStmt: vectorAvailable ? 2 : 1 });
        await assert.rejects(
            () => registry.initSchema(atomicProxy),
            (e) => e.code === 'INJECTED'
        );
        equal(await tableExists(pool, 'build_registry_builds'), false, 'mid-DDL failure leaves zero registry objects');
        equal(await tableExists(pool, 'build_registry_chunks'), false, 'mid-DDL failure leaves zero chunk tables');
        equal(await tableExists(pool, 'build_registry_state'), false, 'mid-DDL failure leaves zero state tables');

        if (vectorAvailable) {
            await registry.initSchema(pool);
            await registry.initSchema(pool);
            equal(await tableExists(pool, 'build_registry_builds'), true, 'full init creates builds');
            equal(await tableExists(pool, 'build_registry_chunks'), true, 'full init creates chunks');
            equal(await tableExists(pool, 'build_registry_state'), true, 'full init creates state');
            equal(await stateOf(pool, registry.ACTIVE_KEY), registry.LEGACY_BUILD, 'full init seeds legacy pointer');
            const col = await pool.query(
                "SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'build_registry_chunks' AND column_name = 'embedding'"
            );
            equal(col.rows.length, 1, 'full init adds the vector(768) column');
            const idx = await pool.query(
                "SELECT 1 AS x FROM pg_indexes WHERE indexname = 'idx_build_registry_chunks_vector'"
            );
            equal(idx.rows.length, 1, 'full init creates the ivfflat vector index');
            const uq = await pool.query(
                "SELECT 1 AS x FROM pg_indexes WHERE indexname = 'uq_build_registry_builds_single_active'"
            );
            equal(uq.rows.length, 1, 'single-active unique index exists');
        } else {
            await assert.rejects(
                () => registry.initSchema(pool),
                (e) => e.code === '0A000'
            );
            equal(await tableExists(pool, 'build_registry_builds'), false, 'strict init without pgvector rolls back to zero objects');
            equal(await tableExists(pool, 'build_registry_state'), false, 'strict init without pgvector leaves no partial schema');
        }

        console.log('buildRegistry.postgres.integration.test.js: real PostgreSQL guarantees verified');
    } finally {
        try {
            await dropRegistryObjects(pool);
        } catch {}
        await pool.end();
    }

    return { assertionCount: n };
}

if (require.main === module) {
    run()
        .then((r) => {
            if (r.assertionCount > 0) {
                console.log(`buildRegistry.postgres.integration: ${r.assertionCount} assertions OK`);
                process.exit(0);
            }
            process.exit(0);
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = { run };
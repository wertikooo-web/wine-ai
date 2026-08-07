'use strict';

// Real-PostgreSQL integration tests for src/buildRegistry/builder.js — the full
// versioned build pipeline against a live pg Pool (pgvector required for the
// embedding column). Skips cleanly when TEST_DATABASE_URL is unset; the CI job
// .github/workflows/build-registry-postgres-integration.yml runs it against a
// pgvector/pgvector:pg16 service.

const assert = require('assert');

async function run() {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) {
        console.log('skip: buildRegistryBuilder.postgres.integration.test.js requires TEST_DATABASE_URL (real PostgreSQL)');
        return { assertionCount: 0 };
    }

    const { Pool } = require('pg');
    const registry = require('../src/buildRegistry/registry');
    const builder = require('../src/buildRegistry/builder');

    const pool = new Pool({ connectionString: testUrl, max: 8 });
    let n = 0;
    const ok = (cond, msg) => { n += 1; assert.ok(cond, msg); };
    const equal = (a, b, msg) => { n += 1; assert.strictEqual(a, b, msg); };
    const eqNot = (a, b, msg) => { n += 1; assert.notStrictEqual(a, b, msg); };

    const TEXTS = {
        doc_a: 'Alpha body paragraph one about Feteasca Alba.\n\nAlpha body paragraph two about Moldova wine country.',
        doc_b: 'Beta body paragraph one about Cabernet grapes.\n\nBeta body paragraph two about aging in oak barrels.',
    };

    function fixtureManifest(overrides = {}) {
        const entry = (ref, id, hash) => ({
            source_ref: ref, source_type: 'kos_source_document', source_id: id,
            title: `Title ${id}`, language: 'ru', status: 'active', include: true,
            storage: 'postgres:kos_source_documents.normalized_text',
            hashes: { normalized_text_sha256: hash }, estimated_chunks: 1, duplicate_group: null,
        });
        return {
            generated_at: '2026-08-05T00:00:00Z',
            mode: 'read-only',
            production_snapshot: 'integration-fixture',
            entries: [
                entry('kos:doc_a', 'doc_a', builder.sha256Text(TEXTS.doc_a)),
                entry('kos:doc_b', 'doc_b', builder.sha256Text(TEXTS.doc_b)),
                ...(overrides.entries || []),
            ],
        };
    }

    async function seedSources(p, { withA = true, withB = true } = {}) {
        await p.query('DROP TABLE IF EXISTS kos_source_documents');
        await p.query('CREATE TABLE kos_source_documents (id TEXT PRIMARY KEY, normalized_text TEXT NOT NULL)');
        if (withA) await p.query('INSERT INTO kos_source_documents (id, normalized_text) VALUES ($1, $2)', ['doc_a', TEXTS.doc_a]);
        if (withB) await p.query('INSERT INTO kos_source_documents (id, normalized_text) VALUES ($1, $2)', ['doc_b', TEXTS.doc_b]);
    }

    async function cleanup(p) {
        await p.query('DROP TABLE IF EXISTS build_registry_chunks');
        await p.query('DROP TABLE IF EXISTS build_registry_builds');
        await p.query('DROP TABLE IF EXISTS build_registry_state');
        await p.query('DROP TABLE IF EXISTS kos_source_documents');
    }

    try {
        await cleanup(pool);

        // --- schema init + vector dimension introspection ---
        await registry.initSchema(pool);
        const dim = await builder.embeddingDimension(pool);
        equal(dim.dimension, builder.EMBEDDING_DIMENSIONS, 'vector dimension matches configured model output');
        equal(dim.source, 'build_registry_chunks.embedding', 'dimension read from the actual schema column');

        // --- full build against real PG -> ready ---
        await seedSources(pool);
        const manifest = fixtureManifest();
        const report = await builder.runBuild({ pool, manifest, dryRun: false, createdBy: 'integration' });
        equal(report.status, 'ready', 'all-green gates -> ready');
        equal(report.verification.passed, true, 'verification passes');
        equal(report.source_count, 2, 'two sources');
        ok(report.chunk_count > 0, 'chunks materialized');
        equal(report.chunk_count, report.embedding_count, 'full embedding coverage');

        const { rows: buildRows } = await pool.query(
            'SELECT status, input_fingerprint, chunk_count, embedding_count, model, hooks_version FROM build_registry_builds WHERE build_id = $1',
            [report.build_id]
        );
        equal(buildRows.length, 1, 'build row persisted');
        equal(buildRows[0].status, 'ready', 'persisted status ready');
        equal(buildRows[0].input_fingerprint, report.input_fingerprint, 'persisted fingerprint matches');
        equal(buildRows[0].model, builder.EMBEDDING_MODEL, 'model recorded');
        equal(buildRows[0].hooks_version, builder.HOOKS_VERSION, 'hooks_version recorded');

        const { rows: chunkRows } = await pool.query(
            'SELECT chunk_id, embedding FROM build_registry_chunks WHERE build_id = $1',
            [report.build_id]
        );
        equal(chunkRows.length, report.chunk_count, 'chunk rows match plan');
        ok(chunkRows.every((r) => r.embedding !== null), 'every chunk has a stored vector');

        // --- idempotent re-run: same build_id, reused when ready ---
        const second = await builder.runBuild({ pool, manifest, dryRun: false });
        equal(second.build_id, report.build_id, 'deterministic build_id across runs');
        equal(second.reused, true, 'ready build reused without --resume');
        const { rows: countAfter } = await pool.query(
            'SELECT COUNT(*)::int AS c FROM build_registry_chunks WHERE build_id = $1',
            [report.build_id]
        );
        equal(countAfter[0].c, report.chunk_count, 'no duplicate chunks on re-run');

        // --- resume forces a re-pass and stays idempotent ---
        const resumed = await builder.runBuild({ pool, manifest, dryRun: false, resume: true });
        equal(resumed.reused, false, 'resume forces a re-pass');
        equal(resumed.status, 'ready', 'resume re-verifies to ready');
        equal(resumed.chunk_count, report.chunk_count, 'unchanged content -> identical counts');

        // --- verification gates reject a tampered row on a forced resume ---
        const { rows: tamperTarget } = await pool.query(
            'SELECT chunk_id FROM build_registry_chunks WHERE build_id = $1 LIMIT 1',
            [report.build_id]
        );
        await pool.query(
            'UPDATE build_registry_chunks SET content_hash = $1 WHERE build_id = $2 AND chunk_id = $3',
            ['deadbeef', report.build_id, tamperTarget[0].chunk_id]
        );
        const tampered = await builder.runBuild({ pool, manifest, dryRun: false, resume: true });
        equal(tampered.status, 'verification_failed', 'tampered content_hash blocks ready');
        ok(String(tampered.verification.failures).includes('content_hash'), 'reports content_hash mismatch');

        // --- live DB text drifted from the pinned manifest -> build refuses ---
        await seedSources(pool, { withA: true, withB: false });
        await pool.query('INSERT INTO kos_source_documents (id, normalized_text) VALUES ($1, $2)', ['doc_b', 'Completely different drifted text.']);
        let code = null;
        try {
            await builder.runBuild({ pool, manifest, dryRun: false, resume: true });
        } catch (err) {
            code = err.code;
        }
        equal(code, builder.ERROR.SOURCE_FETCH_FAILED, 'drifted DB text aborts the build (input pin at fetch time)');

        // --- dry-run is read-only and deterministic on the same manifest ---
        const dry1 = await builder.runBuild({ manifest, dryRun: true });
        const dry2 = await builder.runBuild({ manifest, dryRun: true });
        equal(dry1.dry_run, true, 'dry-run flag');
        equal(dry1.status, 'dry-run', 'dry-run status');
        equal(dry1.build_id, dry2.build_id, 'dry-run build_id deterministic');
        equal(dry1.build_id, report.build_id, 'dry-run build_id equals the real build_id for the same manifest');
        const { rows: dryCount } = await pool.query(
            'SELECT COUNT(*)::int AS c FROM build_registry_builds WHERE build_id = $1',
            [report.build_id]
        );
        equal(dryCount[0].c, 1, 'dry-run wrote nothing (still one build row)');
    } finally {
        await cleanup(pool);
        await pool.end();
    }

    console.log(`builder postgres integration: ${n} assertions`);
    return { assertionCount: n };
}

module.exports = { run };
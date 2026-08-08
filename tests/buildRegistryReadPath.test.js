'use strict';

// Phase 0B — versioned read path verification for the v2 Build Registry
// (docs/architecture/BUILD_REGISTRY_DESIGN.md §5.2). The same corpus served as
// a legacy index.json and as build_registry_chunks rows must produce identical
// keyword hits through search(chunkSource='build'), proving parity while never
// touching index.json.
//
// Covered here:
//   1. loadBuildRegistryChunks filters by build_id and disabled state.
//   2. search(chunkSource='build') serves hits from the build rows directly.
//   3. parity: legacy (index.json) vs build rows return identical hit ids.
//   4. build source without a build_id is rejected with a clear code.

const fs = require('fs');
const path = require('path');
const os = require('os');
const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { buildIndex } = require('../src/knowledge/index');
const { loadBuildRegistryChunks } = require('../src/knowledge/chunkStore');
const { search } = require('../src/knowledge/search');
const searchMode = require('../src/knowledge/searchMode');
const db = require('../src/knowledge/db');

function chunkRow(buildId, { id, text, enabled = true }) {
    const meta = {
        title: 'Doc',
        language: 'ru',
        doc_type: 'wine_guide',
        source: 'https://wine.md/doc',
    };
    return {
        chunk_id: id,
        source_file: `${id}.md`,
        title: meta.title,
        doc_type: meta.doc_type,
        language: meta.language,
        source: meta.source,
        confidence: 'high',
        entity_id: null,
        winery: null,
        region: null,
        grape: null,
        date: null,
        enabled,
        chunk_index: 0,
        text,
        build_id: buildId,
    };
}

async function insertRow(pool, row) {
    return pool.query(
        `INSERT INTO build_registry_chunks (
            build_id, chunk_id, source_file, title, doc_type, language, source,
            confidence, entity_id, winery, region, grape, date, enabled,
            chunk_index, text
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
            row.build_id, row.chunk_id, row.source_file, row.title, row.doc_type,
            row.language, row.source, row.confidence, row.entity_id, row.winery,
            row.region, row.grape, row.date, row.enabled, row.chunk_index, row.text,
        ]
    );
}

const TEXT_A = 'Cricova produces sparkling wine in Moldova.';
const TEXT_B = 'Fetească Neagră is a dark grape variety of Moldova.';
const TEXT_C = 'In the cellars of Cricova a collection wine is aged.';
const CORPUS = {
    a: TEXT_A,
    b: TEXT_B,
    c: TEXT_C,
};

function makeIndexFile(texts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-readpath-'));
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const indexFile = path.join(dir, 'index.json');
    Object.keys(texts).forEach((key) => {
        fs.writeFileSync(path.join(srcDir, `${key}.md`), texts[key]);
    });
    const built = buildIndex({ sourceDir: srcDir, indexFile });
    if (!built) throw new Error('buildIndex produced no index');
    return indexFile;
}

async function run() {
    const origMode = searchMode.getMode();
    const origIsEnabled = db.isEnabled;
    const origGetPool = db.getPool;

    try {
        searchMode.setMode('keyword');

        // ------------------------------------------------------------------ //
        // 1. loadBuildRegistryChunks filters by build_id and disabled state.
        // ------------------------------------------------------------------ //
        const pool = createMemoryPgPool();
        const ids = ['a', 'b', 'c'];
        for (const id of ids) {
            await insertRow(pool, chunkRow('b1', { id, text: CORPUS[id] }));
            await insertRow(pool, chunkRow('b2', { id, text: CORPUS[id] }));
        }
        // disable chunk c within build b1 (memory engine has no UPDATE handler
        // for build_registry_chunks, so toggle the row directly)
        const b1Table = pool.tables.get('build_registry_chunks');
        b1Table.rows.find((r) => r.build_id === 'b1' && r.chunk_id === 'c').enabled = false;

        const b1 = await loadBuildRegistryChunks(pool, 'b1');
        t.equal(b1.buildId, 'b1', 'buildId echoed in result');
        t.equal(b1.chunks.length, ids.length - 1, 'disabled chunk excluded from build b1');
        t.ok(!b1.chunks.some((c) => c.id === 'c'), 'disabled chunk id absent');
        t.ok(b1.chunks.some((c) => c.id === 'a'), 'enabled chunk present');

        const b2 = await loadBuildRegistryChunks(pool, 'b2');
        t.equal(b2.chunks.length, ids.length, 'other build unaffected by b1 disable');

        // ------------------------------------------------------------------ //
        // 2. search(chunkSource='build') serves from build rows directly.
        // ------------------------------------------------------------------ //
        const pool2 = createMemoryPgPool();
        for (const id of ids) {
            await insertRow(pool2, chunkRow('MA1', { id, text: CORPUS[id] }));
        }
        db.isEnabled = () => true;
        db.getPool = () => pool2;
        const res = await search('Cricova', { language: 'en', limit: 4, chunkSource: 'build', buildId: 'MA1' });
        t.equal(res.diagnostics.chunkSource, 'build', 'search reports build chunk source');
        t.equal(res.diagnostics.buildId, 'MA1', 'search reports the served build_id');
        t.ok(res.hits.length > 0, 'search returns hits from the build');
        t.ok(res.hits.some((h) => h.chunk.text.includes('Cricova')), 'Cricova chunk found from build rows');

        // ------------------------------------------------------------------ //
        // 3. parity: legacy (index.json) vs build rows, same content.
        // ------------------------------------------------------------------ //
        const indexFile = makeIndexFile(CORPUS);
        const legacy = await search('Fetească Neagră', { language: 'en', limit: 4, indexFile });
        const legacyChunks = fs.readFileSync(indexFile, 'utf8');
        const idx = JSON.parse(legacyChunks);
        const pool3 = createMemoryPgPool();
        for (const chunk of idx.chunks) {
            await insertRow(pool3, chunkRow('PAR', { id: chunk.id, text: chunk.text }));
        }
        db.getPool = () => pool3;
        const builtRes = await search('Fetească Neagră', { language: 'en', limit: 4, chunkSource: 'build', buildId: 'PAR' });
        t.equal(
            legacy.hits.length,
            builtRes.hits.length,
            'legacy and build return the same number of hits'
        );
        t.deepEqual(
            legacy.hits.map((h) => h.chunk.id),
            builtRes.hits.map((h) => h.chunk.id),
            'legacy and build read paths return identical hit ids'
        );

        // ------------------------------------------------------------------ //
        // 4. build source without a build_id is rejected.
        // ------------------------------------------------------------------ //
        const pool4 = createMemoryPgPool();
        db.isEnabled = () => true;
        db.getPool = () => pool4;
        const bad = await search('Cricova', { chunkSource: 'build' })
            .then(() => null, (e) => e);
        t.ok(bad && bad.code === 'BUILD_ID_REQUIRED', 'chunkSource=build without buildId is rejected');
        t.ok(bad && bad.build_id === undefined, 'no build_id on the rejection error');

        // ------------------------------------------------------------------ //
        // 5. followActiveBuild serves the versioned build after cutover and
        //    the legacy corpus after rollback.
        // ------------------------------------------------------------------ //
        const registry = require('../src/buildRegistry/registry');
        const searchWineKnowledge = require('../src/tools/searchWineKnowledge');
        const pool5 = createMemoryPgPool();
        // registry state table
        const activeKey = registry.ACTIVE_KEY || 'active_build';
        const previousKey = registry.PREVIOUS_KEY || 'previous_build';
        const legacyId = registry.LEGACY_BUILD;
        await pool5.query(
            `CREATE TABLE IF NOT EXISTS build_registry_state (key TEXT PRIMARY KEY, value TEXT)`
        );
        await pool5.query(
            `CREATE TABLE IF NOT EXISTS build_registry_builds (build_id TEXT PRIMARY KEY, status TEXT)`
        );
        const stateTbl = pool5.tables.get('build_registry_state');
        stateTbl.rows.push({ key: activeKey, value: legacyId }, { key: previousKey, value: legacyId });
        const buildsTbl = pool5.tables.get('build_registry_builds');
        buildsTbl.rows.push({ build_id: 'BETA', status: 'active' });
        for (const id of ids) {
            await insertRow(pool5, chunkRow('BETA', { id, text: CORPUS[id] }));
        }
        // no index.json exists for this pool context; legacy pointer must still
        // resolve via resolveActiveBuild without throwing.
        db.getPool = () => pool5;

        // cutover: active pointer = BETA -> search serves the build
        pool5.tables.get('build_registry_state').rows.find((r) => r.key === activeKey).value = 'BETA';
        const served = await search('Cricova', { language: 'en', limit: 4, followActiveBuild: true });
        t.equal(served.diagnostics.chunkSource, 'build', 'followActiveBuild serves the versioned build');
        t.equal(served.diagnostics.buildId, 'BETA', 'followActiveBuild reports BETA');
        t.ok(served.hits.length > 0 && served.hits.some((h) => h.chunk.text.includes('Cricova')), 'cutover build content served');

        // rollback: active pointer = legacy -> resolveActiveBuild returns legacy.
        // Point the legacy file path at an empty index so the rollback seam is
        // deterministic (the repo default index.json is the real corpus).
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-rollback-'));
        const emptyIndexFile = path.join(emptyDir, 'index.json');
        fs.writeFileSync(emptyIndexFile, JSON.stringify({ built_at: new Date().toISOString(), chunk_count: 0, chunks: [] }));
        pool5.tables.get('build_registry_state').rows.find((r) => r.key === activeKey).value = legacyId;
        const rolledBack = await search('Cricova', { language: 'en', limit: 4, indexFile: emptyIndexFile, followActiveBuild: true });
        t.equal(rolledBack.diagnostics.chunkSource, 'legacy', 'followActiveBuild reports legacy after rollback');
        t.equal(rolledBack.diagnostics.buildId, legacyId, 'rollback leaves active pointer at legacy');
        t.equal(rolledBack.hits.length, 0, 'no build chunks served after rollback (legacy corpus absent here)');

        // ------------------------------------------------------------------ //
        // 6. The production tool searchWineKnowledge follows the active build:
        //    cutover changes what the assistant serves with NO code change.
        // ------------------------------------------------------------------ //
        const pool6 = createMemoryPgPool();
        const active6 = registry.ACTIVE_KEY || 'active_build';
        const previous6 = registry.PREVIOUS_KEY || 'previous_build';
        const legacy6 = registry.LEGACY_BUILD;
        await pool6.query(
            `CREATE TABLE IF NOT EXISTS build_registry_state (key TEXT PRIMARY KEY, value TEXT)`
        );
        await pool6.query(
            `CREATE TABLE IF NOT EXISTS build_registry_builds (build_id TEXT PRIMARY KEY, status TEXT)`
        );
        pool6.tables.get('build_registry_state').rows.push(
            { key: active6, value: legacy6 },
            { key: previous6, value: legacy6 }
        );
        pool6.tables.get('build_registry_builds').rows.push({ build_id: 'PROD', status: 'active' });
        for (const id of ids) {
            await insertRow(pool6, chunkRow('PROD', { id, text: CORPUS[id] }));
        }
        db.isEnabled = () => true;
        db.getPool = () => pool6;
        searchMode.setMode('keyword');

        // legacy pointer -> tool serves from the legacy index only
        const legacyTool = await searchWineKnowledge.impl({ query: 'aging collection bottle' }, {});
        t.equal(legacyTool.status, 'found', 'tool finds from legacy with legacy pointer');

        // cutover -> same tool call now reads the v2 build rows
        pool6.tables.get('build_registry_state').rows.find((r) => r.key === active6).value = 'PROD';
        const cutoverTool = await searchWineKnowledge.impl({ query: 'dark Moldovan grape' }, {});
        t.equal(cutoverTool.status, 'found', 'tool still resolves after cutover');
        t.ok(
            cutoverTool.results && cutoverTool.results.some((r) => /Fetească/i.test(r.text)),
            'tool served content from the versioned build after cutover'
        );

        console.log('buildRegistryReadPath.test.js: Phase 0B passed (build-qualified read path, disabled filtering, legacy/build parity, cutover/rollback seam, production tool cutover)');
        return true;
    } finally {
        searchMode.setMode(origMode);
        db.isEnabled = origIsEnabled;
        db.getPool = origGetPool;
    }
}

module.exports = { run };

if (require.main === module) {
    run().then((ok) => {
        if (ok !== true) process.exit(1);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
'use strict';

// Stage 2 verification for the PG-as-source-of-truth migration
// (docs/audits/PG_MIGRATION_PLAN.md): the chunk-source selector loadChunks()
// plus the optional chunkSource wiring in search().
//
// Covered here:
//   1. explicit source:'file'
//   2. explicit source:'postgres' (memory pool, populated)
//   3. source:'auto' with an available, populated Postgres
//   4. fallback on a Postgres query error (auto -> file, warned)
//   5. fallback on an empty Postgres table (auto -> file, warned) — an empty
//      PG table is NOT treated as a healthy knowledge base
//   6. explicit source:'postgres' with empty table -> ChunkSourceError (the
//      chosen fixed behavior: forced postgres fails loudly, auto warns+falls back)
//   7. the active chunk source is ALWAYS logged (success and fallback)
//   8. returned chunk shape is identical for file and postgres
//   9. search() modes (keyword/hybrid/disabled) behave identically with the
//      chunk source wiring as without it; default search() is unchanged
//  10. the searchWineKnowledge contract (declaration + impl return shapes) is
//      unchanged

const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { loadChunks, ChunkSourceError, CHUNK_SOURCES, CHUNK_SOURCE_ENV, DEFAULT_INDEX_FILE } = require('../src/knowledge/index');
const { importChunksToPostgres } = require('../src/knowledge/chunkStore');
const { buildChunksAndVerify } = require('../scripts/knowledge-chunks-sync');
const { search } = require('../src/knowledge/search');
const searchMode = require('../src/knowledge/searchMode');
const db = require('../src/knowledge/db');
const searchWineKnowledge = require('../src/tools/searchWineKnowledge');

const SOURCE_DIR = path.resolve(__dirname, '..', 'knowledge', 'source');
const INDEX_FILE = DEFAULT_INDEX_FILE;

const CHUNK_SHAPE_KEYS = ['id', 'text', 'metadata'];

function assertChunkShape(label, chunk) {
    for (const key of CHUNK_SHAPE_KEYS) {
        t.ok(key in chunk, `${label}: chunk must have key "${key}"`);
    }
    t.ok(typeof chunk.id === 'string' && chunk.id.length > 0, `${label}: id is a non-empty string`);
    t.ok(typeof chunk.text === 'string' && chunk.text.length > 0, `${label}: text is a non-empty string`);
    t.ok(typeof chunk.metadata === 'object' && chunk.metadata !== null, `${label}: metadata is an object`);
}

async function run() {
    t.ok(CHUNK_SOURCES.has('file') && CHUNK_SOURCES.has('postgres') && CHUNK_SOURCES.has('auto'), 'CHUNK_SOURCES exports the three valid sources');

    // Real-corpus chunks (shared by the postgres-side assertions).
    const real = buildChunksAndVerify({ sourceDir: SOURCE_DIR, log: () => {} });
    t.ok(real.chunks.length > 0, `real corpus chunked (${real.chunks.length} chunks)`);

    // ------------------------------------------------------------------ //
    // 1. Explicit source:'file' — always the filesystem index.
    // ------------------------------------------------------------------ //
    const fileLogs = [];
    const fileResult = await loadChunks({ source: 'file', indexFile: INDEX_FILE, log: (m) => fileLogs.push(m) });
    t.equal(fileResult.source, 'file', 'source:file returns source=file');
    t.equal(fileResult.fallback, null, 'source:file has no fallback reason');
    t.equal(fileResult.chunks.length, real.chunks.length, 'source:file returns the full file corpus');
    fileResult.chunks.slice(0, 5).forEach((c, i) => assertChunkShape(`file#${i}`, c));
    t.ok(fileLogs.some((m) => /chunk source: file/.test(m)), 'source:file logs the active source');

    // ------------------------------------------------------------------ //
    // Empty memory pool fixture (postgres-side fallback tests).
    // NOTE: createMemoryPgPool() shares ONE global engine and resets it, so
    // the empty-pool scenarios must run before the populated pool below.
    // ------------------------------------------------------------------ //
    const emptyPool = createMemoryPgPool();
    await emptyPool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            chunk_id TEXT PRIMARY KEY,
            source_file TEXT NOT NULL,
            title TEXT, doc_type TEXT, language TEXT, source TEXT, confidence TEXT,
            entity_id TEXT, winery TEXT, region TEXT, grape TEXT, date TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            chunk_index INT NOT NULL DEFAULT 0,
            text TEXT NOT NULL, content_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // ------------------------------------------------------------------ //
    // 5. Fallback on an empty Postgres table (auto -> file, warned).
    // ------------------------------------------------------------------ //
    const emptyLogs = [];
    const emptyWarns = [];
    const emptyResult = await loadChunks({
        source: 'auto', pool: emptyPool, indexFile: INDEX_FILE,
        log: (m) => emptyLogs.push(m), warn: (m) => emptyWarns.push(m),
    });
    t.equal(emptyResult.source, 'file', 'auto falls back to file when postgres table is empty');
    t.equal(emptyResult.fallback, 'postgres_empty', 'fallback reason is postgres_empty');
    t.equal(emptyResult.chunks.length, real.chunks.length, 'empty-pg fallback returns the file corpus');
    t.ok(emptyWarns.some((m) => /chunk source: file/.test(m) && /empty/.test(m)), 'empty-pg fallback is warned, not silent');

    // ------------------------------------------------------------------ //
    // 6. Explicit source:'postgres' with an empty table -> explicit error
    //    (chosen fixed behavior: forced postgres never silently serves file).
    // ------------------------------------------------------------------ //
    let emptyPgError = null;
    try {
        await loadChunks({ source: 'postgres', pool: emptyPool, indexFile: INDEX_FILE, log: () => {} });
    } catch (err) {
        emptyPgError = err;
    }
    t.ok(emptyPgError instanceof ChunkSourceError, 'explicit postgres with empty table throws ChunkSourceError');
    t.equal(emptyPgError.code, 'postgres_empty', 'empty-table error code is postgres_empty');

    // Explicit source:'postgres' with no pool at all -> postgres_unavailable.
    const origDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    let unavailableError = null;
    try {
        await loadChunks({ source: 'postgres', indexFile: INDEX_FILE, log: () => {} });
    } catch (err) {
        unavailableError = err;
    }
    t.ok(unavailableError instanceof ChunkSourceError, 'explicit postgres without a pool throws ChunkSourceError');
    t.equal(unavailableError.code, 'postgres_unavailable', 'no-pool error code is postgres_unavailable');
    process.env.DATABASE_URL = origDbUrl;

    // ------------------------------------------------------------------ //
    // Memory pool populated with the real corpus (postgres side fixture).
    // ------------------------------------------------------------------ //
    const pool = createMemoryPgPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
            chunk_id TEXT PRIMARY KEY,
            source_file TEXT NOT NULL,
            title TEXT, doc_type TEXT, language TEXT, source TEXT, confidence TEXT,
            entity_id TEXT, winery TEXT, region TEXT, grape TEXT, date TEXT,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            chunk_index INT NOT NULL DEFAULT 0,
            text TEXT NOT NULL, content_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    const imported = await importChunksToPostgres({ pool, chunks: real.chunks, dryRun: false });
    t.equal(imported.inserted, real.chunks.length, 'fixture import inserted every chunk');

    // ------------------------------------------------------------------ //
    // 2. Explicit source:'postgres' — postgres only, no fallback.
    // ------------------------------------------------------------------ //
    const pgLogs = [];
    const pgResult = await loadChunks({ source: 'postgres', pool, indexFile: INDEX_FILE, log: (m) => pgLogs.push(m) });
    t.equal(pgResult.source, 'postgres', 'source:postgres returns source=postgres');
    t.equal(pgResult.fallback, null, 'source:postgres has no fallback reason');
    t.equal(pgResult.chunks.length, real.chunks.length, 'source:postgres returns the full imported corpus');
    pgResult.chunks.slice(0, 5).forEach((c, i) => assertChunkShape(`pg#${i}`, c));
    t.ok(pgLogs.some((m) => /chunk source: postgres/.test(m)), 'source:postgres logs the active source');

    // ------------------------------------------------------------------ //
    // 8. Identical chunk shape, file vs postgres, on the same source docs.
    //    Same chunk ids too (the 1:1 embeddings join key must line up).
    // ------------------------------------------------------------------ //
    t.equal(pgResult.chunks.length, fileResult.chunks.length, 'pg and file return the same chunk count');
    const idMismatch = pgResult.chunks.findIndex((c, i) => c.id !== fileResult.chunks[i].id);
    t.equal(idMismatch, -1, 'pg chunk ids match file chunk ids exactly (join key stability)');
    const shapeMismatch = pgResult.chunks.findIndex((c, i) => {
        const f = fileResult.chunks[i];
        return CHUNK_SHAPE_KEYS.some((k) => !(k in c) || !(k in f));
    });
    t.equal(shapeMismatch, -1, 'pg and file chunks expose the same keys');

    // ------------------------------------------------------------------ //
    // 3. source:'auto' with an available, populated Postgres -> postgres.
    // ------------------------------------------------------------------ //
    const autoOkLogs = [];
    const autoOk = await loadChunks({ source: 'auto', pool, indexFile: INDEX_FILE, log: (m) => autoOkLogs.push(m) });
    t.equal(autoOk.source, 'postgres', 'auto with healthy postgres picks postgres');
    t.equal(autoOk.chunks.length, real.chunks.length, 'auto postgres path returns the full corpus');
    t.ok(autoOkLogs.some((m) => /chunk source: postgres/.test(m)), 'auto success logs postgres');

    // ------------------------------------------------------------------ //
    // 4. Fallback on a Postgres query error (auto -> file, warned).
    // ------------------------------------------------------------------ //
    const throwingPool = { async query() { throw new Error('connection reset'); } };
    const errLogs = [];
    const errWarns = [];
    const errResult = await loadChunks({
        source: 'auto', pool: throwingPool, indexFile: INDEX_FILE,
        log: (m) => errLogs.push(m), warn: (m) => errWarns.push(m),
    });
    t.equal(errResult.source, 'file', 'auto falls back to file on a postgres error');
    t.equal(errResult.fallback, 'postgres_error', 'fallback reason is postgres_error');
    t.equal(errResult.chunks.length, real.chunks.length, 'fallback returns the file corpus');
    t.ok(errWarns.some((m) => /chunk source: file/.test(m) && /postgres error/.test(m)), 'error fallback is warned, not silent');

    // ------------------------------------------------------------------ //
    // 9. search() modes behave identically with and without the chunkSource
    //    wiring; the default (no chunkSource) path is unchanged.
    // ------------------------------------------------------------------ //
    const origMode = searchMode.getMode();
    const origIsEnabled = db.isEnabled;
    const origGetPool = db.getPool;
    try {
        // Feed the memory pool through db so search()'s chunkSource path sees it.
        db.isEnabled = () => true;
        db.getPool = () => pool;

        // keyword mode: explicit postgres source -> keyword mode, same top hit.
        searchMode.setMode('keyword');
        const kwFile = await search('Фетяска Нягрэ', { language: 'ru', limit: 2 });
        const kwPg = await search('Фетяска Нягрэ', { language: 'ru', limit: 2, chunkSource: 'postgres' });
        t.equal(kwFile.mode, 'keyword', 'default keyword mode preserved');
        t.equal(kwPg.mode, 'keyword', 'chunkSource postgres keeps keyword mode');
        t.ok(kwFile.hits.length > 0 && kwPg.hits.length > 0, 'keyword search returns hits from both sources');
        t.equal(kwPg.hits[0].chunk.id, kwFile.hits[0].chunk.id, 'same top hit from file and postgres chunks');
        t.equal(kwPg.diagnostics.chunkSource, 'postgres', 'search diagnostics report the active chunk source');

        // hybrid mode (no embeddings configured -> falls back to keyword).
        searchMode.setMode('hybrid');
        const hyFile = await search('Фетяска Нягрэ', { language: 'ru', limit: 2 });
        const hyPg = await search('Фетяска Нягрэ', { language: 'ru', limit: 2, chunkSource: 'postgres' });
        t.equal(hyFile.mode, hyPg.mode, 'hybrid mode behaves identically for file and postgres chunks');

        // disabled mode: short-circuits before touching any chunk source.
        searchMode.setMode('disabled');
        const disFile = await search('Фетяска Нягрэ', { language: 'ru', limit: 2 });
        const disPg = await search('Фетяска Нягрэ', { language: 'ru', limit: 2, chunkSource: 'postgres' });
        t.equal(disFile.mode, 'disabled', 'disabled mode preserved (file)');
        t.equal(disPg.mode, 'disabled', 'disabled mode preserved (postgres)');
        t.equal(disPg.diagnostics.chunkSource, null, 'disabled mode does not resolve a chunk source');
        t.deepEqual(disPg.hits, [], 'disabled mode returns no hits');

        // auto mode through search(): healthy postgres -> postgres chunks.
        searchMode.setMode('keyword');
        const autoSearch = await search('Фетяска Нягрэ', { language: 'ru', limit: 2, chunkSource: 'auto' });
        t.equal(autoSearch.diagnostics.chunkSource, 'postgres', 'search auto picks postgres when available');
        t.equal(autoSearch.diagnostics.chunkFallback, null, 'search auto reports no fallback');
        t.ok(autoSearch.hits.length > 0, 'search auto returns hits');
    } finally {
        searchMode.setMode(origMode);
        db.isEnabled = origIsEnabled;
        db.getPool = origGetPool;
    }

    // Default search() (no chunkSource option, no env flag) is untouched.
    const origEnv = process.env[CHUNK_SOURCE_ENV];
    delete process.env[CHUNK_SOURCE_ENV];
    const defaultSearch = await search('Фетяска Нягрэ', { language: 'ru', limit: 2 });
    t.ok(defaultSearch.hits.length > 0, 'default search still returns hits');
    t.equal(defaultSearch.diagnostics.chunkSource, null, 'default search does not resolve a chunk source');
    if (origEnv !== undefined) process.env[CHUNK_SOURCE_ENV] = origEnv;

    // ------------------------------------------------------------------ //
    // 10. searchWineKnowledge contract is unchanged.
    // ------------------------------------------------------------------ //
    t.equal(searchWineKnowledge.declaration.name, 'search_wine_knowledge', 'tool name unchanged');
    t.equal(typeof searchWineKnowledge.declaration.description, 'string', 'tool description is a string');
    t.deepEqual(searchWineKnowledge.declaration.parameters.required, ['query'], 'tool requires only query');
    const toolResult = await searchWineKnowledge.impl({ query: 'Фетяска Нягрэ' }, {});
    t.equal(typeof toolResult.found, 'boolean', 'impl returns found boolean');
    t.ok(['found', 'not_found', 'error'].includes(toolResult.status), 'impl returns a valid status');
    t.ok(Array.isArray(toolResult.results), 'impl returns a results array');
    for (const r of toolResult.results) {
        for (const key of ['text', 'title', 'source', 'confidence', 'language', 'relevance_score']) {
            t.ok(key in r, `result entry has key "${key}"`);
        }
    }
    t.equal(toolResult.status, 'found', 'real query still resolves to found');

    console.log('knowledgeChunksSelector.test.js: Stage 2 passed (selector, search wiring, contract preservation)');
}

module.exports = { run };

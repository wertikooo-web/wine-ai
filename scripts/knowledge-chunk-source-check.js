'use strict';

// Stage 2 real-Postgres verification (docs/audits/PG_MIGRATION_PLAN.md):
// proves the chunk-source selector (loadChunks) and the search() chunkSource
// wiring work against an actual PostgreSQL with DATABASE_URL set.
//
// Run (after scripts/knowledge-chunks-sync.js has populated knowledge_chunks):
//   set DATABASE_URL=postgres://...   (PowerShell)  — or set it in your shell
//   node scripts/knowledge-chunk-source-check.js
//
// Exit 0 = all checks pass; exit 1 = any check failed (with the reason printed).

const path = require('path');
const db = require('../src/knowledge/db');
const { loadChunks, DEFAULT_INDEX_FILE } = require('../src/knowledge/index');
const { search } = require('../src/knowledge/search');

const SOURCE_DIR = path.resolve(__dirname, '..', 'knowledge', 'source');

async function runChecks(pool) {
    const fileChunks = (await loadChunks({ source: 'file', indexFile: DEFAULT_INDEX_FILE, log: () => {} })).chunks;
    console.log(`file index chunks: ${fileChunks.length}`);

    // 1. Explicit source:postgres — returns the full corpus.
    const pg = await loadChunks({ source: 'postgres', pool, indexFile: DEFAULT_INDEX_FILE, log: (m) => console.log(m) });
    console.log(`postgres chunks: ${pg.chunks.length}`);
    if (pg.chunks.length < fileChunks.length) {
        throw new Error(`postgres has fewer chunks than the file index (${pg.chunks.length} < ${fileChunks.length}) — run scripts/knowledge-chunks-sync.js first`);
    }

    // 2. Explicit source:file — still works, index.json untouched.
    const file = await loadChunks({ source: 'file', indexFile: DEFAULT_INDEX_FILE, log: (m) => console.log(m) });
    if (file.source !== 'file') throw new Error('source:file did not return the file index');

    // 3. source:auto — must pick postgres when it is healthy and non-empty.
    const auto = await loadChunks({ source: 'auto', pool, indexFile: DEFAULT_INDEX_FILE, log: (m) => console.log(m) });
    if (auto.source !== 'postgres') throw new Error(`auto did not pick postgres (source=${auto.source}, fallback=${auto.fallback})`);

    // 4. search() with chunkSource postgres — real hits from PG chunks.
    const result = await search('Фетяска Нягрэ', { language: 'ru', limit: 3, chunkSource: 'postgres' });
    if (result.diagnostics.chunkSource !== 'postgres') throw new Error(`search chunkSource not postgres (${result.diagnostics.chunkSource})`);
    if (result.hits.length === 0) throw new Error('search over postgres chunks returned zero hits');
    console.log(`search chunkSource=postgres: mode=${result.mode} hits=${result.hits.length} top=${result.hits[0].chunk.metadata.title}`);

    // 5. search() default (no chunkSource) — unchanged file behavior.
    const def = await search('Фетяска Нягрэ', { language: 'ru', limit: 3 });
    if (def.hits.length === 0) throw new Error('default search returned zero hits');
    if (def.diagnostics.chunkSource !== null) throw new Error('default search must not resolve a chunk source');
    console.log('default search (file) unchanged');

    console.log('\nStage 2 real-Postgres verification OK — loadChunks + search(chunkSource) pass against real PostgreSQL.');
}

async function main() {
    if (!db.isEnabled()) {
        console.error('DATABASE_URL not set — nothing to verify against. Aborting.');
        process.exitCode = 1;
        return;
    }

    const pool = await db.init();
    if (!pool) {
        console.error('Postgres pool unavailable after init().');
        process.exitCode = 1;
        return;
    }

    await runChecks(pool);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('knowledge-chunk-source-check failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { main, runChecks };

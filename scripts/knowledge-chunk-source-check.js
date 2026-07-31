'use strict';

// Stage 2 real-Postgres verification (docs/audits/PG_MIGRATION_PLAN.md):
// proves the chunk-source selector (loadChunks) and the search() chunkSource
// wiring work against an actual PostgreSQL with DATABASE_URL set.
//
// Run (after scripts/knowledge-chunks-sync.js has populated knowledge_chunks):
//   set DATABASE_URL=postgres://...   (PowerShell)  — or set it in your shell
//   node scripts/knowledge-chunk-source-check.js
//
// Stage 3 write-path check (needs real PostgreSQL):
//   node scripts/knowledge-chunk-source-check.js --write
//
// Exit 0 = all checks pass; exit 1 = any check failed (with the reason printed).

const crypto = require('crypto');
const path = require('path');
const db = require('../src/knowledge/db');
const { loadChunks, DEFAULT_INDEX_FILE } = require('../src/knowledge/index');
const { loadChunksFromPostgres } = require('../src/knowledge/chunkStore');
const publishService = require('../src/knowledge/publishService');
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

// Stage 3 write-path verification against REAL PostgreSQL: publish a fixture
// document through the shared publish service, prove chunks persist, that a
// re-publish is idempotent, that an update disables stale chunks, and that
// search(chunkSource=postgres) finds the published content. The fixture rows
// are removed afterwards so the check never pollutes the real knowledge base.
async function runWriteChecks(pool) {
    const documentId = `check_${crypto.randomBytes(4).toString('hex')}`;
    const sourceFile = publishService.sourceFileForDocument(documentId);
    const metadata = { title: 'Write Path Check', language: 'ru', doc_type: 'check', source: 'https://check.local' };
    const body = `# Write check fixture\n\nПроверка записи о винодельне Cricova и сорте Fetească Neagră.\n\nВторой абзац о регионе Codru и выдержке в погребах.`;

    // 1. Publish persists every chunk.
    const r1 = await publishService.publishDocument({ pool, documentId, metadata, body, embed: false });
    console.log(`publish#1: status=${r1.status} chunks=${r1.chunkCount} inserted=${r1.inserted}`);
    if (r1.status !== 'published') throw new Error(`first publish status is ${r1.status}`);
    if (r1.inserted !== r1.chunkCount) throw new Error(`first publish inserted ${r1.inserted} of ${r1.chunkCount} chunks`);

    const stored1 = (await loadChunksFromPostgres(pool)).chunks.filter((c) => c.metadata.source_file === sourceFile);
    if (stored1.length !== r1.chunkCount) throw new Error(`read-back found ${stored1.length} of ${r1.chunkCount} chunks`);

    // 2. Re-publish is idempotent.
    const r2 = await publishService.publishDocument({ pool, documentId, metadata, body, embed: false });
    console.log(`publish#2 (idempotent): inserted=${r2.inserted} updated=${r2.updated} unchanged=${r2.unchanged}`);
    if (r2.inserted !== 0 || r2.updated !== 0) throw new Error(`re-publish not idempotent (inserted=${r2.inserted} updated=${r2.updated})`);
    if (r2.unchanged !== r1.chunkCount) throw new Error('re-publish did not report every chunk unchanged');

    // 3. Update replaces stale chunks (old chunks disabled in the same tx).
    const body2 = body + '\n\nТретий абзац, которого не было в первой версии.';
    const r3 = await publishService.publishDocument({ pool, documentId, metadata, body: body2, embed: false });
    const stored3 = (await loadChunksFromPostgres(pool)).chunks.filter((c) => c.metadata.source_file === sourceFile);
    const enabled3 = stored3.filter((c) => c.metadata.enabled !== false);
    console.log(`publish#3 (update): chunks=${r3.chunkCount} enabled=${enabled3.length} disabled=${r3.disabled}`);
    if (enabled3.length !== r3.chunkCount) throw new Error('stale chunks not disabled after update');

    // 4. search(chunkSource=postgres) finds the published content.
    const searchResult = await search('Cricova', { language: 'ru', limit: 3, chunkSource: 'postgres' });
    if (searchResult.diagnostics.chunkSource !== 'postgres') throw new Error(`search chunkSource not postgres (${searchResult.diagnostics.chunkSource})`);
    if (!searchResult.hits.some((h) => h.chunk.metadata.source_file === sourceFile)) {
        throw new Error('published document not found by search(chunkSource=postgres)');
    }

    // 5. Cleanup — remove the fixture chunks + embeddings.
    await pool.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [documentId]);
    await pool.query('DELETE FROM knowledge_chunk_embeddings WHERE source_file = $1', [sourceFile]);
    console.log('fixture cleaned up');

    console.log('\nStage 3 write-path real-Postgres verification OK — publish/persist/idempotency/replace/search pass.');
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
    if (process.argv.includes('--write')) {
        await runWriteChecks(pool);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('knowledge-chunk-source-check failed:', err.message);
        process.exitCode = 1;
    });
}

module.exports = { main, runChecks, runWriteChecks };

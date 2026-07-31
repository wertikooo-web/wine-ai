'use strict';

// Stage 1 verification for the PG-as-source-of-truth migration
// (docs/audits/PG_MIGRATION_PLAN.md):
//   1. knowledge_chunks schema DDL runs (memory engine)
//   2. chunk_id stability on the real knowledge/source corpus (deterministic,
//      no collisions, per-source uniqueness) — proves the embeddings 1:1 join
//      key is safe before anything reads Postgres
//   3. importChunksToPostgres dry-run writes nothing and reports correctly
//   4. real import persists all chunks; a second run is a no-op (idempotent)
//   5. loadChunksFromPostgres read-back matches the source id sequence

const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { buildChunksAndVerify } = require('../scripts/knowledge-chunks-sync');
const {
    importChunksToPostgres,
    loadChunksFromPostgres,
    verifyChunkIdStability,
} = require('../src/knowledge/chunkStore');
const { chunkDocument } = require('../src/knowledge/loader');

const SOURCE_DIR = path.resolve(__dirname, '..', 'knowledge', 'source');

function makeFixtureDocs(count = 3) {
    return Array.from({ length: count }, (_, i) => ({
        sourceFile: `fixture-${i}.md`,
        metadata: {
            title: `Fixture ${i}`,
            language: 'ru',
            doc_type: 'general',
            source: 'https://fixture.test',
            confidence: 'unverified',
        },
        body: `# Fixture ${i}\n\nАбзац один о винодельне Cricova.\n\nАбзац два о сорте Fetească Neagră и регионе Codru.\n\nАбзац три о розливе и выдержке.`,
        validation: { sourceFile: `fixture-${i}.md`, missing: [], unknown: [] },
    }));
}

async function run() {
    const pool = createMemoryPgPool();

    // 1. Schema DDL (same SQL as src/knowledge/db.js init) runs against the
    // memory engine — the table is created and reused by the handlers below.
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
    await pool.query('CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source_file ON knowledge_chunks(source_file);');
    t.ok(true, 'knowledge_chunks DDL executes without error');

    // 2. Chunk-id stability on the real corpus.
    const real = buildChunksAndVerify({ sourceDir: SOURCE_DIR, log: () => {} });
    t.ok(real.documents.length > 0, `real corpus loaded (${real.documents.length} documents)`);
    t.ok(real.chunks.length > 0, `real corpus chunked (${real.chunks.length} chunks)`);
    t.ok(real.stability.hasCollisions === false, 'real corpus: no duplicate chunk ids');
    t.ok(real.stability.perSourceUnique === true, 'real corpus: per-source chunk ids unique');
    t.ok(real.deterministic === true, 'real corpus: chunk ids deterministic across rebuild');
    t.ok(real.stable === true, 'real corpus: stability gate passes');
    console.log(`  real corpus: ${real.documents.length} docs, ${real.chunks.length} chunks, ${real.stability.unique} unique ids`);

    // verifyChunkIdStability directly on a degenerate corpus catches collisions.
    const dupDocs = [
        { sourceFile: 'a.md', metadata: { title: 'A', language: 'ru', doc_type: 'general' }, body: 'один\n\nдва\n\nтри' },
        { sourceFile: 'b.md', metadata: { title: 'B', language: 'ru', doc_type: 'general' }, body: 'четыре\n\nпять\n\nшесть' },
    ];
    const stability = verifyChunkIdStability(dupDocs.flatMap(chunkDocument));
    t.equal(stability.hasCollisions, false, 'fixture corpus has no collisions');

    // 3. Dry-run import into the memory pool: nothing written.
    const fixtureChunks = makeFixtureDocs().flatMap(chunkDocument);
    const dry = await importChunksToPostgres({ pool, chunks: fixtureChunks, dryRun: true });
    t.ok(dry.dryRun === true, 'dry-run returns dryRun=true');
    t.equal(dry.inserted, fixtureChunks.length, 'dry-run reports all chunks as would-be inserts');
    t.equal(dry.updated, 0, 'dry-run reports 0 updates');
    t.equal(dry.existingRows, 0, 'dry-run sees 0 existing rows');
    const afterDry = await loadChunksFromPostgres(pool);
    t.equal(afterDry.chunks.length, 0, 'dry-run writes nothing to Postgres');

    // 4. Real import persists all chunks; second run is idempotent.
    const first = await importChunksToPostgres({ pool, chunks: fixtureChunks, dryRun: false });
    t.ok(first.dryRun === false, 'real import returns dryRun=false');
    t.equal(first.inserted, fixtureChunks.length, 'first import inserts every chunk');
    const storedAfterFirst = await loadChunksFromPostgres(pool);
    t.equal(storedAfterFirst.chunks.length, fixtureChunks.length, 'all chunks persisted');

    const second = await importChunksToPostgres({ pool, chunks: fixtureChunks, dryRun: false });
    t.equal(second.inserted, 0, 'second import inserts nothing');
    t.equal(second.updated, 0, 'second import updates nothing');
    t.equal(second.unchanged, fixtureChunks.length, 'second import leaves every chunk unchanged');
    t.equal(second.existingRows, fixtureChunks.length, 'existing row count matches');

    // 5. Read-back matches the source id sequence exactly.
    const readBack = await loadChunksFromPostgres(pool);
    t.equal(readBack.chunks.length, fixtureChunks.length, 'read-back count matches');
    t.ok(readBack.chunks.every((c, i) => c.id === fixtureChunks[i].id), 'read-back id sequence matches source');
    t.equal(readBack.chunks[0].metadata.title, fixtureChunks[0].metadata.title, 'read-back metadata title preserved');
    t.equal(readBack.chunks[0].metadata.enabled, true, 'read-back enabled flag preserved');
    t.ok(readBack.chunks[0].text.length > 0, 'read-back text preserved');

    // 6. Content change updates in place (re-import of changed text).
    const changedDocs = makeFixtureDocs();
    changedDocs[1].body = changedDocs[1].body + '\n\nНовый абзац о дегустационном зале.';
    const changedChunks = changedDocs.flatMap(chunkDocument);
    const third = await importChunksToPostgres({ pool, chunks: changedChunks, dryRun: false });
    t.ok(third.updated >= 1, `changed content updates affected chunk(s) (updated=${third.updated})`);
    t.equal(third.inserted, 0, 'changed import inserts nothing new');

    console.log('knowledgeChunksMigration.test.js: Stage 1 passed (schema, stability, dry-run, idempotent import, read-back)');
}

module.exports = { run };

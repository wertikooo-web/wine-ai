'use strict';

// Safety invariants of scripts/knowledge-embed-backfill.js's syncEmbeddings —
// regression coverage for the production incident where an inverted --no-prune
// flag let prune delete 1298 rows while the embedding pass had failed.
//
// Covered here:
//   1. --no-prune (prune=false) leaves stale rows in place
//   2. prune is suppressed when any embedding batch failed
//   3. --dry-run never executes a DELETE (and never calls the API)
//   4. the run logs prune=true|false and dry-run state up front

const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const { chunkDocument } = require('../src/knowledge/loader');
const { chunkToRow, upsertChunkRow } = require('../src/knowledge/chunkStore');
const { syncEmbeddings } = require('../scripts/knowledge-embed-backfill');
const embeddings = require('../src/knowledge/embeddings');

const CHUNKS_DDL = `
    CREATE TABLE IF NOT EXISTS knowledge_chunks (
        chunk_id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        title TEXT, doc_type TEXT, language TEXT, source TEXT, confidence TEXT,
        entity_id TEXT, winery TEXT, region TEXT, grape TEXT, date TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        chunk_index INT NOT NULL DEFAULT 0,
        text TEXT NOT NULL, content_hash TEXT NOT NULL,
        document_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
`;
const EMBEDDINGS_DDL = `
    CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        model TEXT NOT NULL,
        embedding TEXT,
        content_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
`;

function makePool() {
    const pool = createMemoryPgPool();
    pool.query(CHUNKS_DDL);
    pool.query(EMBEDDINGS_DDL);
    return pool;
}

// A real chunk that will need embedding (no matching content_hash yet).
function makeChunk() {
    const doc = {
        sourceFile: 'check_safety_001.md',
        metadata: { title: 'Safety Check', language: 'ru', doc_type: 'check', source: 'https://check.local' },
        body: '# Safety check\n\nПроверка защиты от инцидента с prune.',
    };
    return chunkDocument(doc)[0];
}

function insertChunk(pool, chunk, overrideHash) {
    const row = chunkToRow(chunk);
    row.document_id = 'doc_safety';
    if (overrideHash) row.content_hash = overrideHash;
    return upsertChunkRow(pool, row);
}

function insertStaleEmbedding(pool, id, sourceFile) {
    return pool.query(
        `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_file, model, embedding, content_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, sourceFile, 'test-model', '[0.1,0.2]', 'deadbeef']
    );
}

function countRows(pool) {
    return pool.query('SELECT COUNT(*) AS c FROM knowledge_chunk_embeddings').then((r) => r.rows[0].count);
}

function embedIds(pool) {
    return pool.query('SELECT chunk_id FROM knowledge_chunk_embeddings').then((r) => r.rows.map((x) => x.chunk_id));
}

const okClient = Object.assign({}, embeddings, {
    isEnabled: () => true,
    embedTexts: async (texts) => texts.map((_, i) => [0.1, 0.2, i]),
});
const failingClient = Object.assign({}, embeddings, {
    isEnabled: () => true,
    embedTexts: async () => {
        const err = new Error('gemini_down');
        err.code = 'gemini_down';
        throw err;
    },
});

async function main() {
    // ------------------------------------------------------------------ //
    // 1. prune=false (--no-prune) leaves stale rows in place.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const chunk = makeChunk();
        await insertChunk(pool, chunk);
        await insertStaleEmbedding(pool, 'stale_001', 'old.md');

        const logs = [];
        const result = await syncEmbeddings({ pool, chunks: [chunk], embeddingsClient: okClient, prune: false, log: (m) => logs.push(m) });

        t.equal(result.pruned, 0, 'prune=false reports 0 pruned');
        t.equal(result.pruneSkippedReason, 'no_prune_flag', 'prune=false reports no_prune_flag');
        t.equal(await countRows(pool), 2, 'stale row still present after prune=false');
        t.equal(result.embedded, 1, 'embedding still upserted under --no-prune');
        t.ok(logs.some((m) => /prune=false/.test(m)), 'log shows prune=false up front');
    }

    // ------------------------------------------------------------------ //
    // 2. prune suppressed when any embedding batch failed.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const chunk = makeChunk();
        await insertChunk(pool, chunk, 'stale_hash');
        await insertStaleEmbedding(pool, 'stale_002', 'old.md');

        const result = await syncEmbeddings({ pool, chunks: [chunk], embeddingsClient: failingClient, prune: true });

        t.equal(result.failed, 1, 'the only batch failed');
        t.equal(result.pruned, 0, 'no DELETE after embedding failure');
        t.equal(result.pruneSkippedReason, 'embedding_failures', 'prune skipped with embedding_failures reason');
        const ids2 = await embedIds(pool);
        t.ok(ids2.includes('stale_002'), 'stale embedding survives after failed embedding pass');
        t.ok(!ids2.includes(chunk.id), 'real chunk was not embedded (batch failed)');
    }

    // ------------------------------------------------------------------ //
    // 3. dryRun never executes a DELETE and never calls the API.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const chunk = makeChunk();
        await insertChunk(pool, chunk);
        await insertStaleEmbedding(pool, 'stale_003', 'old.md');

        let apiCalls = 0;
        const spyClient = Object.assign({}, embeddings, {
            isEnabled: () => true,
            embedTexts: async () => {
                apiCalls += 1;
                return [[0.1, 0.2, 0.3]];
            },
        });

        const result = await syncEmbeddings({ pool, chunks: [chunk], embeddingsClient: spyClient, prune: true, dryRun: true });

        t.equal(result.pruned, 0, 'dryRun never prunes');
        t.equal(result.pruneSkippedReason, 'dry_run', 'dryRun reports dry_run reason');
        t.equal(apiCalls, 0, 'dryRun does not call the embeddings API');
        t.equal(await countRows(pool), 1, 'only the pre-existing stale row remains — dryRun wrote nothing');
        t.equal(result.embedded, 1, 'dryRun reports would-embed count');
    }

    // ------------------------------------------------------------------ //
    // 4. prune=true path still works (regression guard).
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const chunk = makeChunk();
        await insertChunk(pool, chunk);
        await insertStaleEmbedding(pool, 'stale_004', 'old.md');

        const result = await syncEmbeddings({ pool, chunks: [chunk], embeddingsClient: okClient, prune: true });

        t.equal(result.pruned, 1, 'healthy prune=true run removes exactly the stale row');
        t.equal(result.pruneSkippedReason, null, 'healthy run has no skip reason');
        const ids = await embedIds(pool);
        t.ok(ids.includes(chunk.id), 'real chunk embedded');
        t.ok(!ids.includes('stale_004'), 'stale row gone');
    }

    console.log('knowledgeBackfillSafety: all assertions passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

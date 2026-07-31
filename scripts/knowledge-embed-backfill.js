'use strict';

// Embedding sync (P0 semantic search + Stage 3 write path): compute embeddings
// for every chunk currently in the knowledge base and upsert them into
// Postgres's knowledge_chunk_embeddings table (see src/knowledge/db.js for
// schema). Idempotent and incremental: skips a chunk whose content_hash already
// matches what's stored, so re-running after adding documents only pays for the
// new/changed chunks, not the whole corpus.
//
// Stage 3 (PG-as-source-of-truth migration): the chunk set is the UNION of
//   - the filesystem knowledge (knowledge/source/*.md, chunked fresh — the
//     legacy/curated contour and the default read source), and
//   - knowledge_chunks in Postgres (Dashboard uploads and crawled documents,
//     published via src/knowledge/publishService.js).
// The embeddings PRUNE is keyed to this union, so embeddings for PG-only
// chunks (which never appear in index.json) are NEVER deleted here — the
// pre-Stage-3 backfill pruned against index.json alone and would have wiped
// uploaded/crawled embeddings.
//
// Usage: node scripts/knowledge-embed-backfill.js
// Requires DATABASE_URL and GEMINI_API_KEY.
const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('../src/knowledge/loader');
const db = require('../src/knowledge/db');
const embeddings = require('../src/knowledge/embeddings');
const { loadChunksFromPostgres } = require('../src/knowledge/chunkStore');

const BATCH_SIZE = 20; // Gemini embedContent accepts a batch of contents per call

/**
 * Load the current chunk set as the union of the filesystem knowledge and the
 * published Postgres chunks. On an id collision the Postgres chunk wins (PG is
 * the future source of truth; uploaded/crawled content takes precedence over a
 * same-id legacy file chunk).
 *
 * @returns {Promise<{chunks:Array, fileChunks:number, pgChunks:number, errors:Array}>}
 */
async function loadChunkUnion(pool) {
    const { documents, errors } = loadDocuments(DEFAULT_SOURCE_DIR);
    const fileChunks = documents.flatMap(chunkDocument);
    const pgResult = await loadChunksFromPostgres(pool);

    const byId = new Map(fileChunks.map((c) => [c.id, c]));
    for (const chunk of pgResult.chunks) byId.set(chunk.id, chunk);

    return { chunks: [...byId.values()], fileChunks: fileChunks.length, pgChunks: pgResult.chunks.length, errors };
}

/**
 * Embed the given chunks (skipping ones already up to date) and prune
 * embeddings whose chunk is no longer in the set. Shared by the CLI and the
 * Stage 3 tests — the embeddings client is injectable so tests never hit the
 * Gemini API.
 *
 * @param {object} opts
 * @param {object} opts.pool pg Pool
 * @param {Array} opts.chunks chunk set to embed against / prune by
 * @param {object} [opts.embeddingsClient] DI (default: src/knowledge/embeddings)
 * @param {function} [opts.log]
 * @returns {Promise<{embedded:number,failed:number,pruned:number,total:number,toEmbed:number}>}
 */
async function syncEmbeddings({ pool, chunks, embeddingsClient = null, log = console.log } = {}) {
    if (!pool) throw new TypeError('syncEmbeddings: pool is required');
    if (!Array.isArray(chunks)) throw new TypeError('syncEmbeddings: chunks must be an array');
    const embedClient = embeddingsClient || embeddings;

    const { rows: existingRows } = await pool.query('SELECT chunk_id, content_hash FROM knowledge_chunk_embeddings');
    const existingHashByChunkId = new Map(existingRows.map((r) => [r.chunk_id, r.content_hash]));

    const toEmbed = chunks.filter((chunk) => existingHashByChunkId.get(chunk.id) !== embedClient.embeddingContentHash(chunk));
    log(`${toEmbed.length} chunk(s) need (re-)embedding; ${chunks.length - toEmbed.length} already up to date.`);

    let embedded = 0;
    let failed = 0;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        try {
            const vectors = await embedClient.embedTexts(batch.map((c) => embedClient.buildEmbeddingText(c)), { taskType: 'RETRIEVAL_DOCUMENT' });
            for (let j = 0; j < batch.length; j += 1) {
                const chunk = batch[j];
                const vectorLiteral = `[${vectors[j].join(',')}]`;
                await pool.query(
                    `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_file, model, embedding, content_hash, updated_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT (chunk_id) DO UPDATE SET
                        source_file = EXCLUDED.source_file,
                        model = EXCLUDED.model,
                        embedding = EXCLUDED.embedding,
                        content_hash = EXCLUDED.content_hash,
                        updated_at = NOW();`,
                    [chunk.id, chunk.metadata.source_file, embedClient.EMBEDDING_MODEL, vectorLiteral, embedClient.embeddingContentHash(chunk)]
                );
                embedded += 1;
            }
            log(`  embedded ${embedded}/${toEmbed.length}...`);
        } catch (err) {
            failed += batch.length;
            log(`  batch starting at index ${i} failed (skipping ${batch.length} chunk(s)): ${err.message}`);
        }
    }

    // Prune rows for chunks that no longer exist (deleted/renamed source files,
    // removed documents). Keyed to the CURRENT chunk set — which includes the
    // PG-only chunks — so PG-only embeddings always survive a backfill run.
    const currentChunkIds = new Set(chunks.map((c) => c.id));
    const staleIds = existingRows.map((r) => r.chunk_id).filter((id) => !currentChunkIds.has(id));
    if (staleIds.length) {
        await pool.query('DELETE FROM knowledge_chunk_embeddings WHERE chunk_id = ANY($1)', [staleIds]);
        log(`Pruned ${staleIds.length} stale row(s) for chunks no longer in the index.`);
    }

    return { embedded, failed, pruned: staleIds.length, total: chunks.length, toEmbed: toEmbed.length };
}

async function main() {
    if (!db.isEnabled()) {
        console.error('DATABASE_URL not set — nothing to backfill against. Aborting.');
        process.exitCode = 1;
        return;
    }
    if (!embeddings.isEnabled()) {
        console.error('GEMINI_API_KEY not set — cannot compute embeddings. Aborting.');
        process.exitCode = 1;
        return;
    }

    const pool = await db.init();
    if (!pool) {
        console.error('Postgres pool unavailable after init() — check pgvector setup logs above.');
        process.exitCode = 1;
        return;
    }

    const union = await loadChunkUnion(pool);
    if (union.errors.length) {
        console.error(`loadDocuments() reported ${union.errors.length} error(s) (continuing with the rest):`, union.errors.slice(0, 5));
    }
    console.log(`Chunk set: ${union.chunks.length} total (${union.fileChunks} from knowledge/source, ${union.pgChunks} from Postgres).`);

    const result = await syncEmbeddings({ pool, chunks: union.chunks });
    console.log(`Done. Embedded: ${result.embedded}, failed: ${result.failed}, pruned: ${result.pruned}.`);
    await pool.end();
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Backfill failed:', err);
        process.exitCode = 1;
    });
}

module.exports = { loadChunkUnion, syncEmbeddings };

'use strict';

// P0 backfill: compute embeddings for every chunk currently in
// knowledge/index/index.json and upsert into Postgres's
// knowledge_chunk_embeddings table (see src/knowledge/db.js for schema).
// Idempotent and incremental: skips a chunk whose content_hash already
// matches what's stored, so re-running after adding a handful of new
// documents only pays for the new/changed chunks, not the whole corpus.
// Usage: node scripts/knowledge-embed-backfill.js
const crypto = require('crypto');
const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('../src/knowledge/loader');
const db = require('../src/knowledge/db');
const embeddings = require('../src/knowledge/embeddings');

const BATCH_SIZE = 20; // Gemini embedContent accepts a batch of contents per call

function contentHash(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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

    const { documents, errors } = loadDocuments(DEFAULT_SOURCE_DIR);
    if (errors.length) {
        console.error(`loadDocuments() reported ${errors.length} error(s) (continuing with the rest):`, errors.slice(0, 5));
    }
    const chunks = documents.flatMap(chunkDocument);
    console.log(`Loaded ${documents.length} documents, ${chunks.length} chunks.`);

    const { rows: existingRows } = await pool.query('SELECT chunk_id, content_hash FROM knowledge_chunk_embeddings');
    const existingHashByChunkId = new Map(existingRows.map((r) => [r.chunk_id, r.content_hash]));

    const toEmbed = chunks.filter((chunk) => existingHashByChunkId.get(chunk.id) !== contentHash(chunk.text));
    console.log(`${toEmbed.length} chunk(s) need (re-)embedding; ${chunks.length - toEmbed.length} already up to date.`);

    let embedded = 0;
    let failed = 0;
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        try {
            const vectors = await embeddings.embedTexts(batch.map((c) => c.text), { taskType: 'RETRIEVAL_DOCUMENT' });
            for (let j = 0; j < batch.length; j += 1) {
                const chunk = batch[j];
                const vector = vectors[j];
                const vectorLiteral = `[${vector.join(',')}]`;
                await pool.query(
                    `INSERT INTO knowledge_chunk_embeddings (chunk_id, source_file, model, embedding, content_hash, updated_at)
                     VALUES ($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT (chunk_id) DO UPDATE SET
                        source_file = EXCLUDED.source_file,
                        model = EXCLUDED.model,
                        embedding = EXCLUDED.embedding,
                        content_hash = EXCLUDED.content_hash,
                        updated_at = NOW();`,
                    [chunk.id, chunk.metadata.source_file, embeddings.EMBEDDING_MODEL, vectorLiteral, contentHash(chunk.text)]
                );
                embedded += 1;
            }
            console.log(`  embedded ${embedded}/${toEmbed.length}...`);
        } catch (err) {
            failed += batch.length;
            console.error(`  batch starting at index ${i} failed (skipping ${batch.length} chunk(s)):`, err.message);
        }
    }

    // Prune rows for chunks that no longer exist (deleted/renamed source files).
    const currentChunkIds = new Set(chunks.map((c) => c.id));
    const { rows: allRows } = await pool.query('SELECT chunk_id FROM knowledge_chunk_embeddings');
    const staleIds = allRows.map((r) => r.chunk_id).filter((id) => !currentChunkIds.has(id));
    if (staleIds.length) {
        await pool.query('DELETE FROM knowledge_chunk_embeddings WHERE chunk_id = ANY($1)', [staleIds]);
        console.log(`Pruned ${staleIds.length} stale row(s) for chunks no longer in the index.`);
    }

    console.log(`Done. Embedded: ${embedded}, failed: ${failed}, pruned: ${staleIds.length}.`);
    await pool.end();
}

main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
});

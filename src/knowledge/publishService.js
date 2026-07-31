'use strict';

// Stage 3 write path (docs/audits/PG_MIGRATION_PLAN.md): the single shared
// service that persists a document's chunks into knowledge_chunks and (best
// effort) their embeddings into knowledge_chunk_embeddings. Every pipeline
// flow that produces searchable knowledge writes through here — Dashboard
// upload, crawl ingestion, and the update/reindex cycles — so there is one
// implementation of chunk persistence, idempotent re-publish, and stale-chunk
// replacement instead of per-flow copies.
//
// Contracts:
//   - publishDocument() commits chunks for ONE document atomically. A failure
//     mid-transaction leaves NO partial document in knowledge_chunks.
//   - Idempotent: re-publishing the same document (same document_id + same
//     content) upserts nothing and leaves existing rows untouched.
//   - Update = replace: chunks the document no longer produces are disabled
//     (enabled = FALSE) in the SAME transaction as the new chunk upserts, so
//     the post-state is always exactly one coherent version of the document.
//   - Embeddings are a second, non-transactional phase (they call an external
//     API and must not hold a DB transaction open). A failed embed never
//     rolls back the persisted chunks — but it is always surfaced in the
//     report (status 'published_embedding_failed'), never a silent success.
//   - Chunk ids follow loader.js stableId(`${sourceFile}#${index}`) with
//     sourceFile = `postgres:${documentId}`, exactly what the read path
//     (buildIndexFromPostgres / loadChunks) expects.

const { chunkDocument } = require('./loader');
const { chunkToRow, upsertChunkRow } = require('./chunkStore');
const embeddings = require('./embeddings');

const EMBED_BATCH_SIZE = 20;

function sourceFileForDocument(documentId) {
    return `postgres:${documentId}`;
}

// Chunk a document exactly the way buildIndexFromPostgres() does on the read
// side, so the same (source_file, index) pairs produce the same chunk ids.
function buildChunks({ documentId, sourceFile, metadata, body }) {
    const doc = {
        sourceFile,
        metadata: {
            title: metadata.title || sourceFile,
            language: metadata.language || 'auto',
            doc_type: metadata.doc_type || 'unknown',
            source: metadata.source || sourceFile,
            confidence: metadata.confidence || 'unverified',
        },
        body,
        validation: { sourceFile, missing: [], unknown: [] },
    };
    return chunkDocument(doc);
}

// Second, non-transactional phase: compute and store embeddings for the chunks
// that need them (content_hash mismatch), in batches. A batch failure is
// recorded, not thrown — chunk persistence is the source of truth.
async function _embedChunks({ pool, chunks, embeddingsClient, log }) {
    const embedClient = embeddingsClient || embeddings;

    const chunkIds = chunks.map((c) => c.id);
    const { rows: existingRows } = await pool.query(
        'SELECT chunk_id, content_hash FROM knowledge_chunk_embeddings WHERE chunk_id = ANY($1)',
        [chunkIds]
    );
    const existingHashByChunkId = new Map(existingRows.map((r) => [r.chunk_id, r.content_hash]));
    const toEmbed = chunks.filter((c) => existingHashByChunkId.get(c.id) !== embedClient.embeddingContentHash(c));

    let embedded = 0;
    let failed = 0;
    const errors = [];
    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + EMBED_BATCH_SIZE);
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
            log(`[knowledge:publish] embedded ${embedded}/${toEmbed.length}...`);
        } catch (err) {
            failed += batch.length;
            errors.push({ stage: 'embedding', message: err.message });
            log(`[knowledge:publish] embedding batch failed (skipping ${batch.length} chunk(s)): ${err.message}`);
        }
    }
    return { embedded, failed, errors };
}

/**
 * Publish one document's chunks into knowledge_chunks (+ embeddings).
 *
 * @param {object} opts
 * @param {object} opts.pool pg Pool
 * @param {string} opts.documentId document-level identity (kos_source_documents.id)
 * @param {string} [opts.sourceFile] defaults to `postgres:${documentId}`
 * @param {object} [opts.metadata] title/language/doc_type/source/confidence
 * @param {string} opts.body normalized text to chunk
 * @param {boolean} [opts.embed=true] attempt embedding phase (when configured)
 * @param {object} [opts.embeddingsClient] DI for tests (default: src/knowledge/embeddings)
 * @param {function} [opts.log]
 * @returns {Promise<{ok:boolean,documentId:string,sourceFile:string,status:string,
 *   chunkCount:number,inserted:number,updated:number,unchanged:number,disabled:number,
 *   embedded:number,embedFailed:number,embeddingSkipped:boolean,errors:Array}>}
 */
async function publishDocument({
    pool,
    documentId,
    sourceFile,
    metadata = {},
    body,
    embed = true,
    embeddingsClient = null,
    log = console.log,
} = {}) {
    if (!pool) throw new TypeError('publishDocument: pool is required');
    if (!documentId) throw new TypeError('publishDocument: documentId is required');
    if (typeof body !== 'string' || body.trim().length === 0) {
        throw new TypeError('publishDocument: body must be a non-empty string');
    }

    const sourceFileResolved = sourceFile || sourceFileForDocument(documentId);
    const chunks = buildChunks({ documentId, sourceFile: sourceFileResolved, metadata, body });

    // Phase 1: transactional chunk write + stale-chunk replacement.
    const client = await pool.connect();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let disabled = 0;
    try {
        await client.query('BEGIN');
        const existingRows = (await client.query(
            'SELECT chunk_id, content_hash FROM knowledge_chunks WHERE document_id = $1',
            [documentId]
        )).rows;
        const existingHashByChunkId = new Map(existingRows.map((r) => [r.chunk_id, r.content_hash]));
        const newChunkIds = new Set(chunks.map((c) => c.id));

        for (const chunk of chunks) {
            const row = chunkToRow(chunk);
            row.document_id = documentId;
            const prevHash = existingHashByChunkId.get(row.chunk_id);
            if (prevHash === undefined) {
                inserted += 1;
            } else if (prevHash === row.content_hash) {
                unchanged += 1;
            } else {
                updated += 1;
            }
            await upsertChunkRow(client, row);
        }

        const staleIds = existingRows.map((r) => r.chunk_id).filter((id) => !newChunkIds.has(id));
        if (staleIds.length > 0) {
            await client.query(
                `UPDATE knowledge_chunks SET enabled = FALSE, updated_at = NOW()
                 WHERE document_id = $1 AND chunk_id = ANY($2)`,
                [documentId, staleIds]
            );
            disabled = staleIds.length;
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (_) {
            /* best-effort rollback */
        }
        throw err;
    } finally {
        client.release();
    }

    const report = {
        ok: true,
        documentId,
        sourceFile: sourceFileResolved,
        status: 'published',
        chunkCount: chunks.length,
        inserted,
        updated,
        unchanged,
        disabled,
        embedded: 0,
        embedFailed: 0,
        embeddingSkipped: false,
        errors: [],
    };

    // Phase 2: embeddings (non-transactional, best effort, never silent).
    if (embed) {
        const embedClient = embeddingsClient || embeddings;
        if (embedClient.isEnabled()) {
            const embedResult = await _embedChunks({ pool, chunks, embeddingsClient, log });
            report.embedded = embedResult.embedded;
            report.embedFailed = embedResult.failed;
            report.errors = embedResult.errors;
            if (embedResult.failed > 0 || embedResult.errors.length > 0) {
                report.status = 'published_embedding_failed';
            }
        } else {
            report.embeddingSkipped = true;
        }
    }

    log(`[knowledge:publish] document=${documentId} source=${sourceFileResolved} status=${report.status} chunks=${report.chunkCount} inserted=${inserted} updated=${updated} unchanged=${unchanged} disabled=${disabled} embedded=${report.embedded} embed_failed=${report.embedFailed}`);
    return report;
}

/**
 * Re-publish every active document currently in kos_source_documents, then
 * disable chunks whose document is no longer active (prune-inactive). Used by
 * the reindex and update flows to keep knowledge_chunks in sync with the
 * document registry. Per-document failures are collected and reported, never
 * thrown — one bad document must not block the rest of the reindex.
 *
 * Safety guard: prune-inactive only runs when there is at least one active
 * document, so an empty (not-yet-populated) document table can never wipe out
 * previously published chunks during the migration window.
 */
async function publishAllFromPostgres({ pool, embed = true, log = console.log, warn = console.warn } = {}) {
    if (!pool) throw new TypeError('publishAllFromPostgres: pool is required');

    const { rows } = await pool.query(`
        SELECT id, canonical_url, title, document_type, normalized_text, language, status, source_id, created_at, updated_at
        FROM kos_source_documents
        WHERE normalized_text IS NOT NULL AND LENGTH(normalized_text) > 0
          AND (status = 'active' OR status IS NULL)
    `);

    const activeDocumentIds = [];
    const errors = [];
    let published = 0;
    for (const row of rows) {
        activeDocumentIds.push(row.id);
        try {
            const report = await publishDocument({
                pool,
                documentId: row.id,
                sourceFile: sourceFileForDocument(row.id),
                metadata: {
                    title: row.title || row.canonical_url,
                    language: row.language || 'auto',
                    doc_type: row.document_type || 'unknown',
                    source: row.canonical_url,
                },
                body: row.normalized_text,
                embed,
                log,
            });
            published += 1;
        } catch (err) {
            errors.push({ documentId: row.id, message: err.message });
            warn(`[knowledge:publish] failed for document=${row.id}: ${err.message}`);
        }
    }

    let disabledInactive = 0;
    if (rows.length > 0) {
        const { rows: chunkDocs } = await pool.query(
            'SELECT DISTINCT document_id FROM knowledge_chunks WHERE document_id IS NOT NULL'
        );
        const inactiveIds = chunkDocs
            .map((r) => r.document_id)
            .filter((id) => !activeDocumentIds.includes(id));
        if (inactiveIds.length > 0) {
            await pool.query(
                'UPDATE knowledge_chunks SET enabled = FALSE, updated_at = NOW() WHERE document_id = ANY($1)',
                [inactiveIds]
            );
            disabledInactive = inactiveIds.length;
            log(`[knowledge:publish] disabled chunks for ${disabledInactive} inactive document(s)`);
        }
    }

    return { published, documents: activeDocumentIds.length, errors, disabledInactive };
}

module.exports = {
    sourceFileForDocument,
    publishDocument,
    publishAllFromPostgres,
};

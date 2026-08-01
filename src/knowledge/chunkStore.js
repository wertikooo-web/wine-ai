'use strict';

// Chunk storage access for the PG-as-source-of-truth migration (Stage 1 —
// docs/audits/PG_MIGRATION_PLAN.md). Provides:
//
//   importChunksToPostgres()  — one-time MIGRATION IMPORT of the existing
//       filesystem knowledge into knowledge_chunks. This is deliberately a
//       migration/import operation (idempotent, dry-run capable), NOT the
//       permanent runtime path for filling Postgres — future writes come from
//       the pipeline (crawl/upload/extraction), not from re-importing files.
//   loadChunksFromPostgres()  — read side, returns chunks in the exact shape
//       search() already consumes (chunk.id + chunk.metadata), so Stage 2 can
//       point search() at Postgres without format conversion.
//   verifyChunkIdStability()  — proves chunk ids are deterministic and unique
//       before/after import (chunk_id is the 1:1 join key with
//       knowledge_chunk_embeddings).
//
// chunk_id uses the exact id scheme from loader.js's stableId()/chunkDocument()
// (sha256(`${sourceFile}#${index}`)), which is what the existing embeddings
// table already keys on — nothing here re-keys chunks.

const crypto = require('crypto');

const CHUNK_HASH_VERSION = 'v1';

// Single upsert column set for knowledge_chunks, shared by the migration
// import (document_id stays NULL) and the Stage 3 publish path (document_id
// set). Keeps one SQL implementation instead of two drifting copies.
const CHUNK_COLUMNS = [
    'chunk_id', 'source_file', 'title', 'doc_type', 'language', 'source', 'confidence',
    'entity_id', 'winery', 'region', 'grape', 'date', 'enabled', 'chunk_index', 'text',
    'content_hash', 'document_id',
];

/**
 * Upsert one knowledge_chunks row (idempotent by chunk_id). Accepts either a
 * pool or a transaction client (pool.connect()) so the publish path can run it
 * inside BEGIN/COMMIT/ROLLBACK.
 *
 * @param {object} poolOrClient pg Pool or connected client
 * @param {object} row chunkToRow() shape (document_id optional)
 * @returns {Promise<{rows:Array}>}
 */
function upsertChunkRow(poolOrClient, row) {
    const values = CHUNK_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    const updates = CHUNK_COLUMNS.filter((c) => c !== 'chunk_id').map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ');
    const sql = `INSERT INTO knowledge_chunks (
            ${CHUNK_COLUMNS.join(', ')}, created_at, updated_at
        ) VALUES (${values}, NOW(), NOW())
        ON CONFLICT (chunk_id) DO UPDATE SET
            ${updates},
            updated_at = NOW();`;
    const params = CHUNK_COLUMNS.map((c) => (row[c] === undefined ? null : row[c]));
    return poolOrClient.query(sql, params);
}

function computeChunkHash(chunk) {
    const m = chunk.metadata || {};
    return crypto.createHash('sha256')
        .update(CHUNK_HASH_VERSION + '\n')
        .update(String(chunk.text || ''))
        .update('\n')
        .update(String(m.source_file || ''))
        .update('\n')
        .update(String(m.title || ''))
        .update('\n')
        .update(String(m.chunk_index ?? ''))
        .digest('hex');
}

function chunkToRow(chunk) {
    const m = chunk.metadata || {};
    return {
        chunk_id: chunk.id,
        source_file: m.source_file || null,
        title: m.title || null,
        doc_type: m.doc_type || null,
        language: m.language || null,
        source: m.source || null,
        confidence: m.confidence || null,
        entity_id: m.entity_id || null,
        winery: m.winery || null,
        region: m.region || null,
        grape: m.grape || null,
        date: m.date || null,
        enabled: m.enabled !== false,
        chunk_index: Number(m.chunk_index ?? 0),
        text: chunk.text,
        content_hash: computeChunkHash(chunk),
    };
}

function rowToChunk(row) {
    return {
        id: row.chunk_id,
        text: row.text,
        metadata: {
            title: row.title,
            winery: row.winery,
            region: row.region,
            grape: row.grape,
            language: row.language,
            doc_type: row.doc_type,
            date: row.date,
            source: row.source,
            confidence: row.confidence,
            source_file: row.source_file,
            chunk_index: row.chunk_index,
            entity_id: row.entity_id,
            enabled: row.enabled !== false,
        },
    };
}

// Determinism + uniqueness proof for chunk ids. Chunk ids are a pure function
// of (source_file, index), so identical input always yields identical ids; this
// verifies the invariants the embeddings 1:1 join depends on.
function verifyChunkIdStability(chunks) {
    const ids = chunks.map((c) => c.id);
    const unique = new Set(ids);
    const seen = new Set();
    const duplicateIds = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    const bySourceFile = new Map();
    for (const chunk of chunks) {
        const file = chunk.metadata.source_file || '?';
        if (!bySourceFile.has(file)) bySourceFile.set(file, []);
        bySourceFile.get(file).push(chunk.id);
    }
    const perSourceUnique = [...bySourceFile.entries()].every(([, list]) => new Set(list).size === list.length);
    return {
        total: ids.length,
        unique: unique.size,
        hasCollisions: duplicateIds.length > 0,
        duplicateIds: [...new Set(duplicateIds)],
        perSourceUnique,
        scheme: 'sha256(source_file#chunk_index)',
    };
}

/**
 * One-time migration import: upsert filesystem-derived chunks into
 * knowledge_chunks. Idempotent — re-running only changes chunks whose content
 * hash differs. In dryRun mode nothing is written; the returned report shows
 * exactly what a real run would insert/update/leave unchanged.
 *
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool
 * @param {Array<{id:string,text:string,metadata:object}>} opts.chunks
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<{dryRun:boolean,inserted:number,updated:number,unchanged:number,total:number,existingRows:number}>}
 */
async function importChunksToPostgres({ pool, chunks, dryRun = false } = {}) {
    if (!pool) throw new TypeError('importChunksToPostgres: pool is required');
    if (!Array.isArray(chunks)) throw new TypeError('importChunksToPostgres: chunks must be an array');

    const { rows: existingRows } = await pool.query('SELECT chunk_id, content_hash FROM knowledge_chunks');
    const existingHashById = new Map(existingRows.map((r) => [r.chunk_id, r.content_hash]));

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const rows = chunks.map(chunkToRow);
    for (const row of rows) {
        const prevHash = existingHashById.get(row.chunk_id);
        if (prevHash === undefined) {
            inserted += 1;
        } else if (prevHash === row.content_hash) {
            unchanged += 1;
        } else {
            updated += 1;
        }
    }

    if (dryRun) {
        return { dryRun: true, inserted, updated, unchanged, total: rows.length, existingRows: existingRows.length };
    }

    for (const row of rows) {
        await upsertChunkRow(pool, row);
    }

    return { dryRun: false, inserted, updated, unchanged, total: rows.length, existingRows: existingRows.length };
}

/**
 * Read chunks from knowledge_chunks in the exact shape search() consumes.
 * Used by Stage 2 (and by the sync script's post-import verification).
 *
 * @returns {Promise<{chunks:Array<{id:string,text:string,metadata:object}>}>}
 */
async function loadChunksFromPostgres(pool) {
    if (!pool) throw new TypeError('loadChunksFromPostgres: pool is required');
    const { rows } = await pool.query(
        'SELECT chunk_id, source_file, title, doc_type, language, source, confidence, entity_id, winery, region, grape, date, enabled, chunk_index, text FROM knowledge_chunks ORDER BY source_file, chunk_index'
    );
    return { chunks: rows.map(rowToChunk) };
}

module.exports = {
    computeChunkHash,
    chunkToRow,
    rowToChunk,
    verifyChunkIdStability,
    importChunksToPostgres,
    loadChunksFromPostgres,
    upsertChunkRow,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('./loader');
const { loadChunksFromPostgres } = require('./chunkStore');

const DEFAULT_INDEX_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'index');
const DEFAULT_INDEX_FILE = path.join(DEFAULT_INDEX_DIR, 'index.json');

const db = require('./db');

// Chunk-source feature flag (Stage 2 of docs/audits/PG_MIGRATION_PLAN.md).
// Unset / any value other than a known source keeps the current file-only
// runtime default. When set, search() reads chunks through loadChunks():
//   KNOWLEDGE_CHUNK_SOURCE=file     — always the filesystem index
//   KNOWLEDGE_CHUNK_SOURCE=postgres — Postgres or an explicit error
//   KNOWLEDGE_CHUNK_SOURCE=auto     — Postgres when healthy, else file (logged)
const CHUNK_SOURCE_ENV = 'KNOWLEDGE_CHUNK_SOURCE';
const CHUNK_SOURCES = new Set(['file', 'postgres', 'auto']);

class ChunkSourceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ChunkSourceError';
        this.code = code;
    }
}

function buildIndex({ sourceDir = DEFAULT_SOURCE_DIR, indexFile = DEFAULT_INDEX_FILE } = {}) {
    const { documents, errors } = loadDocuments(sourceDir);
    const chunks = documents.flatMap(chunkDocument);

    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    const payload = {
        built_at: new Date().toISOString(),
        source_dir: sourceDir,
        document_count: documents.length,
        chunk_count: chunks.length,
        chunks,
    };
    fs.writeFileSync(indexFile, JSON.stringify(payload, null, 2), 'utf8');

    return {
        indexFile,
        documentCount: documents.length,
        chunkCount: chunks.length,
        errors,
    };
}

/**
 * Build index from Postgres (active knowledge).
 * Returns chunks in the same format as filesystem index.
 */
async function buildIndexFromPostgres(pool) {
    const result = { documents: [], errors: [] };

    try {
        const sql = `
            SELECT id, canonical_url, title, document_type, content_hash, normalized_text,
                   language, status, source_id, created_at, updated_at
            FROM kos_source_documents
            WHERE normalized_text IS NOT NULL AND LENGTH(normalized_text) > 0
              AND (status = 'active' OR status IS NULL)
            ORDER BY created_at DESC;
        `;
        const { rows } = await pool.query(sql);

        for (const row of rows) {
            const sourceFile = `postgres:${row.id}`;
            const metadata = {
                title: row.title || row.canonical_url,
                language: row.language || 'auto',
                doc_type: row.document_type || 'unknown',
                source: row.canonical_url,
                confidence: 'unverified',
                updated_at: row.updated_at,
                entity_id: null,
            };
            const body = row.normalized_text;

            result.documents.push({
                sourceFile,
                metadata,
                body,
                validation: { sourceFile, missing: [], unknown: [] },
            });
        }
    } catch (error) {
        result.errors.push({ sourceFile: 'postgres', message: error.message });
    }

    const chunks = result.documents.flatMap(chunkDocument);
    return {
        documents: result.documents,
        chunks,
        errors: result.errors,
    };
}

function loadIndex(indexFile = DEFAULT_INDEX_FILE) {
    if (!fs.existsSync(indexFile)) {
        return { built_at: null, chunk_count: 0, chunks: [] };
    }
    return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
}

/**
 * Chunk-source selector (Stage 2 of docs/audits/PG_MIGRATION_PLAN.md).
 * Returns chunks in the exact shape search() consumes ({id,text,metadata})
 * from either the filesystem index (index.json) or Postgres knowledge_chunks.
 *
 * Modes:
 *   'file'     — always the filesystem index. No Postgres access.
 *   'postgres' — Postgres only. If Postgres is unavailable, errors, or the
 *                knowledge_chunks table is EMPTY, this throws ChunkSourceError
 *                (explicit failure, never a silent file fallback). An empty
 *                Postgres table is NOT treated as a healthy knowledge base.
 *   'auto'     — Postgres when it is enabled AND loads non-empty chunks;
 *                otherwise the filesystem index. Any Postgres failure or an
 *                empty table produces a WARNED fallback to file (never silent),
 *                so search() never hard-fails during the migration window.
 *
 * The active source is always logged — success or fallback — so a production
 * regression that falls back to stale index.json is visible in the log.
 *
 * @param {object} opts
 * @param {'file'|'postgres'|'auto'} [opts.source]
 * @param {string} [opts.indexFile]
 * @param {object} [opts.pool] explicit pg pool (tests/DI); defaults to db.getPool()
 * @param {function} [opts.log] active-source logger (default console.log)
 * @param {function} [opts.warn] fallback warning logger (default console.warn)
 * @returns {Promise<{chunks:Array, source:'file'|'postgres', fallback:string|null}>}
 */
async function loadChunks({ source = 'auto', indexFile = DEFAULT_INDEX_FILE, pool = null, log = console.log, warn = console.warn } = {}) {
    if (!CHUNK_SOURCES.has(source)) {
        throw new TypeError(`loadChunks: invalid source "${source}" (expected file|postgres|auto)`);
    }

    const fileIndex = loadIndex(indexFile);
    const fileChunks = fileIndex.chunks || [];
    const pgPool = pool || (db.isEnabled() ? db.getPool() : null);

    if (source === 'file') {
        log('[knowledge] chunk source: file');
        return { chunks: fileChunks, source: 'file', fallback: null };
    }

    if (source === 'postgres') {
        if (!pgPool) {
            throw new ChunkSourceError('postgres_unavailable', 'loadChunks: source=postgres but Postgres is not enabled (DATABASE_URL not set)');
        }
        let chunks;
        try {
            const result = await loadChunksFromPostgres(pgPool);
            chunks = result.chunks;
        } catch (err) {
            throw new ChunkSourceError('postgres_error', `loadChunks: source=postgres query failed: ${err.message}`);
        }
        if (!chunks || chunks.length === 0) {
            throw new ChunkSourceError('postgres_empty', 'loadChunks: source=postgres but knowledge_chunks is empty — an empty Postgres table is not a healthy knowledge base');
        }
        log('[knowledge] chunk source: postgres');
        return { chunks, source: 'postgres', fallback: null };
    }

    // source === 'auto'
    if (!pgPool) {
        warn('[knowledge] chunk source: file (postgres unavailable — DATABASE_URL not set)');
        return { chunks: fileChunks, source: 'file', fallback: 'postgres_unavailable' };
    }
    try {
        const result = await loadChunksFromPostgres(pgPool);
        if (!result.chunks || result.chunks.length === 0) {
            warn('[knowledge] chunk source: file (postgres empty — falling back, empty PG is not a healthy knowledge base)');
            return { chunks: fileChunks, source: 'file', fallback: 'postgres_empty' };
        }
        log('[knowledge] chunk source: postgres');
        return { chunks: result.chunks, source: 'postgres', fallback: null };
    } catch (err) {
        warn(`[knowledge] chunk source: file (postgres error — falling back: ${err.message})`);
        return { chunks: fileChunks, source: 'file', fallback: 'postgres_error' };
    }
}

module.exports = {
    DEFAULT_INDEX_DIR,
    DEFAULT_INDEX_FILE,
    CHUNK_SOURCES,
    CHUNK_SOURCE_ENV,
    ChunkSourceError,
    buildIndex,
    buildIndexFromPostgres,
    loadIndex,
    loadChunks,
};

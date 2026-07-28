'use strict';

const fs = require('fs');
const path = require('path');
const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('./loader');

const DEFAULT_INDEX_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'index');
const DEFAULT_INDEX_FILE = path.join(DEFAULT_INDEX_DIR, 'index.json');

const db = require('./db');

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

module.exports = {
    DEFAULT_INDEX_DIR,
    DEFAULT_INDEX_FILE,
    buildIndex,
    buildIndexFromPostgres,
    loadIndex,
};

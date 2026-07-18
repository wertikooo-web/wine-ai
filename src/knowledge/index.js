'use strict';

const fs = require('fs');
const path = require('path');
const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('./loader');

const DEFAULT_INDEX_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'index');
const DEFAULT_INDEX_FILE = path.join(DEFAULT_INDEX_DIR, 'index.json');

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
    loadIndex,
};

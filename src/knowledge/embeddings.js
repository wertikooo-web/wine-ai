'use strict';

// Gemini embeddings client for semantic search (P0 of the hybrid
// keyword+semantic retrieval plan — see docs/KNOWLEDGE_RUNTIME_AUDIT.md
// §17 P2). Deliberately isolated behind a tiny contract (embedText/
// embedTexts) so the rest of the pipeline (backfill script, search.js's
// future semantic branch) never touches the Gemini SDK directly — swapping
// providers later means changing only this file.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 768);

// Embedding payload version. Chunks are embedded from a composed text payload
// (metadata + text); the hash of THAT payload — not the raw chunk text — is
// what knowledge_chunk_embeddings.content_hash stores, so both the backfill
// and the publish path must build the payload and hash identically.
const EMBEDDING_PAYLOAD_VERSION = 'v2';

const crypto = require('crypto');

// Compose the exact text sent to the embeddings model for a chunk. Shared by
// scripts/knowledge-embed-backfill.js and src/knowledge/publishService.js so
// a chunk published at upload time hashes to the same embedding payload as the
// same chunk seen by a later backfill run (idempotent incremental embedding).
function buildEmbeddingText(chunk) {
    const meta = chunk.metadata || {};
    const parts = [];
    if (meta.title) parts.push(`Title: ${meta.title}`);
    if (meta.entity_id) parts.push(`Entity ID: ${meta.entity_id}`);
    if (meta.winery) parts.push(`Winery: ${meta.winery}`);
    if (meta.region) parts.push(`Region: ${meta.region}`);
    if (meta.grape) parts.push(`Grape: ${meta.grape}`);
    if (meta.doc_type) parts.push(`Type: ${meta.doc_type}`);
    if (meta.language) parts.push(`Language: ${meta.language}`);
    parts.push('');
    parts.push(chunk.text);
    return parts.join('\n');
}

function embeddingContentHash(chunk) {
    return crypto.createHash('sha256')
        .update(EMBEDDING_PAYLOAD_VERSION + '\n', 'utf8')
        .update(buildEmbeddingText(chunk), 'utf8')
        .digest('hex');
}

function isEnabled() {
    return Boolean(process.env.GEMINI_API_KEY);
}

async function embedTexts(texts, { apiKey, taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) {
        const error = new Error('gemini_api_key_missing');
        error.code = 'gemini_api_key_missing';
        throw error;
    }
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });

    const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: texts,
        config: {
            taskType,
            outputDimensionality: EMBEDDING_DIMENSIONS,
        },
    });

    const embeddings = response?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        const error = new Error('unexpected_embedding_response_shape');
        error.code = 'unexpected_embedding_response_shape';
        throw error;
    }
    return embeddings.map((e) => e.values);
}

async function embedText(text, options = {}) {
    const [vector] = await embedTexts([text], { ...options, taskType: options.taskType || 'RETRIEVAL_QUERY' });
    return vector;
}

module.exports = {
    isEnabled,
    embedText,
    embedTexts,
    buildEmbeddingText,
    embeddingContentHash,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_PAYLOAD_VERSION,
};

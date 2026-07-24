'use strict';

// Gemini embeddings client for semantic search (P0 of the hybrid
// keyword+semantic retrieval plan — see docs/KNOWLEDGE_RUNTIME_AUDIT.md
// §17 P2). Deliberately isolated behind a tiny contract (embedText/
// embedTexts) so the rest of the pipeline (backfill script, search.js's
// future semantic branch) never touches the Gemini SDK directly — swapping
// providers later means changing only this file.
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS || 768);

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
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
};

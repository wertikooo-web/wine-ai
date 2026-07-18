'use strict';

// Dependency-free retrieval for v1: tokenized term-overlap scoring with a
// metadata boost (grape/winery/region name mentioned in the query). No
// embeddings/vector store — swap this module out behind the same
// search(query, options) contract if retrieval quality demands it later;
// callers (src/tools/searchWineKnowledge.js) do not need to change.
const { loadIndex } = require('./index');

function tokenize(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 2);
}

function scoreChunk(queryTokens, chunk) {
    const bodyTokens = new Set(tokenize(chunk.text));
    let overlap = 0;
    for (const token of queryTokens) {
        if (bodyTokens.has(token)) overlap += 1;
    }
    if (overlap === 0) return 0;

    let score = overlap;
    const metaText = [chunk.metadata.title, chunk.metadata.winery, chunk.metadata.region, chunk.metadata.grape]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    for (const token of queryTokens) {
        if (metaText.includes(token)) score += 2;
    }
    return score;
}

// Returns { hits, tookMs }. Each hit: { chunk, score }. Empty query or empty
// index returns an empty hit list (never throws) — an empty knowledge base
// is a normal, expected state (see docs/ARCHITECTURE.md), not an error.
function search(query, { limit = 4, language = null, indexFile } = {}) {
    const startedAt = Date.now();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
        return { hits: [], tookMs: Date.now() - startedAt };
    }

    const index = loadIndex(indexFile);
    const candidates = language
        ? index.chunks.filter((chunk) => !chunk.metadata.language || chunk.metadata.language === language)
        : index.chunks;

    const scored = candidates
        .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return { hits: scored, tookMs: Date.now() - startedAt };
}

module.exports = {
    tokenize,
    search,
};

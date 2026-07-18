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

// Common short function words (articles, conjunctions, "about"/"which"/
// "is" equivalents across the supported languages) trivially appear in
// almost any sufficiently long document — counting them as body-overlap
// signal let a long, generic page (mentioning the topic only in passing)
// occasionally outrank a short, specifically-titled document that's
// actually about the query. Found via the knowledge-smoke Romanian
// Fetească Neagră case once the corpus grew past the original 6 curated
// docs. Excluding them here rather than filtering tokenize() globally,
// since tokenize() is also used for building the searchable index itself.
const SCORING_STOPWORDS = new Set([
    'despre', 'care', 'este', 'și', 'un', 'o', 'la', 'de', 'în', 'cu', 'ce', 'sau',
    'the', 'and', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'with', 'that', 'this',
    'о', 'об', 'что', 'это', 'как', 'для', 'на', 'из', 'или', 'вы', 'же',
]);

function scoreChunk(queryTokens, chunk) {
    const significantTokens = queryTokens.filter((t) => !SCORING_STOPWORDS.has(t));
    const bodyTokens = new Set(tokenize(chunk.text));
    let overlap = 0;
    for (const token of significantTokens) {
        if (bodyTokens.has(token)) overlap += 1;
    }
    if (overlap === 0) return 0;

    let score = overlap;
    const metaText = [chunk.metadata.title, chunk.metadata.winery, chunk.metadata.region, chunk.metadata.grape]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    // Weighted higher than body overlap — a query term appearing in the
    // document's own title/winery/region/grape metadata is a much stronger
    // "this document is actually about that" signal than merely containing
    // the word somewhere in a long body of text.
    for (const token of significantTokens) {
        if (metaText.includes(token)) score += 4;
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

'use strict';

// Retrieval for wine knowledge. v1 was dependency-free tokenized
// term-overlap scoring only. P1 adds an optional semantic branch (pgvector
// + Gemini embeddings) fused with the same keyword scoring via Reciprocal
// Rank Fusion — see docs/KNOWLEDGE_RUNTIME_AUDIT.md §17 P2 and
// src/knowledge/searchMode.js for the runtime on/off toggle. Keyword
// search remains the always-available fallback: if semantic search is
// enabled but errors (no DB, no API key, embedding call fails), search()
// silently falls back to keyword-only rather than throwing — a knowledge
// lookup failing outright is worse than a slightly-worse-ranked answer.
const { loadIndex } = require('./index');
const searchMode = require('./searchMode');
const db = require('./db');
const embeddings = require('./embeddings');

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

function keywordSearch(query, { limit, language, indexFile } = {}) {
    const startedAt = Date.now();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
        return { hits: [], tookMs: Date.now() - startedAt, index: null };
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

    return { hits: scored, tookMs: Date.now() - startedAt, index };
}

// Nearest-neighbor lookup against knowledge_chunk_embeddings. Returns
// chunk_ids ranked by cosine distance (ascending — closer first), NOT
// resolved against the live index.json here, since the caller already has
// the index loaded from the keyword pass and can do that cheaper lookup
// itself with a Map.
async function semanticCandidateIds(query, { limit }) {
    if (!db.isEnabled() || !embeddings.isEnabled()) return null;
    const pool = db.getPool();
    if (!pool) return null;

    const queryVector = await embeddings.embedText(query, { taskType: 'RETRIEVAL_QUERY' });
    const vectorLiteral = `[${queryVector.join(',')}]`;
    const { rows } = await pool.query(
        `SELECT chunk_id, embedding <=> $1 AS distance
         FROM knowledge_chunk_embeddings
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1
         LIMIT $2;`,
        [vectorLiteral, limit]
    );
    return rows.map((r) => r.chunk_id);
}

// Reciprocal Rank Fusion — combines two ranked lists into one without
// needing their scores to be on comparable scales (keyword overlap counts
// vs. cosine distance are not directly comparable). k=60 is the standard
// RRF constant from the original paper (Cormack et al. 2009); it just
// controls how much rank position 1 is favored over position 10 — not
// worth tuning until real query logs justify it.
function reciprocalRankFusion(rankedLists, k = 60) {
    const scoreByKey = new Map();
    for (const list of rankedLists) {
        list.forEach((key, rank) => {
            const rrfScore = 1 / (k + rank + 1);
            scoreByKey.set(key, (scoreByKey.get(key) || 0) + rrfScore);
        });
    }
    return [...scoreByKey.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}

// Returns { hits, tookMs, mode }. Each hit: { chunk, score }. Empty query or
// empty index returns an empty hit list (never throws) — an empty
// knowledge base is a normal, expected state (see docs/ARCHITECTURE.md),
// not an error. `mode` reports what actually ran ('keyword' or 'hybrid'),
// which can differ from searchMode.getMode() if hybrid was requested but
// fell back (see module comment above).
async function search(query, { limit = 4, language = null, indexFile } = {}) {
    const startedAt = Date.now();
    const keyword = keywordSearch(query, { limit, language, indexFile });

    const wantsHybrid = searchMode.getMode() === 'hybrid';
    if (!wantsHybrid || !keyword.index) {
        return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword' };
    }

    try {
        const semanticIds = await semanticCandidateIds(query, { limit: limit * 3 });
        if (!semanticIds || semanticIds.length === 0) {
            return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword' };
        }

        const chunkById = new Map(keyword.index.chunks.map((c) => [c.id, c]));
        const keywordIds = keyword.hits.map((h) => h.chunk.id);
        const fusedIds = reciprocalRankFusion([keywordIds, semanticIds]).slice(0, limit);

        // Resolve fused ids back to chunks + a display score. Keyword score
        // is reused where available (it's meaningful to a human reading
        // relevance_score); a chunk that only semantic search surfaced gets
        // a synthetic score of 1 so it doesn't read as "0 relevance" in the
        // tool output.
        const keywordScoreById = new Map(keyword.hits.map((h) => [h.chunk.id, h.score]));
        const hits = fusedIds
            .map((id) => chunkById.get(id))
            .filter(Boolean)
            .map((chunk) => ({ chunk, score: keywordScoreById.get(chunk.id) || 1 }));

        return { hits, tookMs: Date.now() - startedAt, mode: 'hybrid' };
    } catch (err) {
        console.error('[knowledge search] semantic branch failed, falling back to keyword-only:', err.message);
        return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword' };
    }
}

module.exports = {
    tokenize,
    search,
};

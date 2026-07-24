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
    // Corpus-specific, not general-language, stopwords: every document in
    // this knowledge base is about Moldovan wine, so "вино"/"молдова" and
    // their inflections carry almost no discriminative signal here even
    // though IDF alone doesn't rate them as rare enough to ignore (they're
    // in maybe 5-10% of chunks, not 90%+, so plain IDF gives them a
    // deceptively "moderate" weight) — found via the Kosher-package case:
    // an article titled "...Молдова представила вина..." was outranking
    // the actually-relevant chunk purely because of these two words
    // appearing in ITS title, stacking with the title-match boost below.
    'вино', 'вина', 'вин', 'вином', 'вине', 'винам', 'винами', 'винах', 'винный', 'винной', 'винного',
    'молдова', 'молдовы', 'молдове', 'молдову', 'молдовой', 'молдавский', 'молдавское', 'молдавская', 'молдавские', 'молдавии', 'молдовский',
]);

// IDF (inverse document frequency) weighting — a word that appears in
// nearly every chunk ("вино", "молдова" in this corpus) is worthless for
// distinguishing which chunk actually answers the query, while a word that
// appears in only a handful of chunks ("kosher", an estate/brand name, a
// specific certification) is exactly the signal that should dominate
// ranking. Flat +1-per-matching-token scoring (the original v1 design)
// weighted both identically, which is precisely why a broad query like
// "кошерные вина Молдова" couldn't surface a specific Kosher-tasting-
// package chunk out of ~900 candidates: the generic "вино"/"молдова"
// overlap drowned out the one word that actually mattered. Standard
// smoothed IDF: idf(t) = ln((N+1)/(df(t)+1)) + 1 — always positive
// (minimum weight 1, same as the old flat scheme, for a term that's in
// literally every chunk), grows for rarer terms, never divides by zero.
//
// Cached per index build (keyed on index.built_at) rather than computed
// per query — the corpus only changes when buildIndex() runs, so
// recomputing document frequencies on every single search would be pure
// waste at this corpus size (~1k chunks) but still unnecessary waste.
let idfCache = { builtAt: null, idf: null };

function buildIdfIndex(index) {
    if (idfCache.builtAt === index.built_at && idfCache.idf) {
        return idfCache.idf;
    }
    const docFrequency = new Map();
    for (const chunk of index.chunks) {
        const uniqueTokens = new Set(tokenize(chunk.text));
        for (const token of uniqueTokens) {
            docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
        }
    }
    const totalChunks = index.chunks.length || 1;
    const idf = new Map();
    for (const [token, df] of docFrequency) {
        idf.set(token, Math.log((totalChunks + 1) / (df + 1)) + 1);
    }
    idfCache = { builtAt: index.built_at, idf };
    return idf;
}

// Terms with no recorded document frequency (shouldn't normally happen —
// every token in the corpus was counted while building the IDF index) get
// this same "appears everywhere" floor rather than an arbitrary guess.
const DEFAULT_IDF_WEIGHT = 1;

function scoreChunk(queryTokens, chunk, idf) {
    const significantTokens = queryTokens.filter((t) => !SCORING_STOPWORDS.has(t));
    const bodyTokens = new Set(tokenize(chunk.text));
    let score = 0;
    for (const token of significantTokens) {
        if (bodyTokens.has(token)) score += idf.get(token) || DEFAULT_IDF_WEIGHT;
    }
    if (score === 0) return 0;

    const metaText = [chunk.metadata.title, chunk.metadata.winery, chunk.metadata.region, chunk.metadata.grape]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    // Weighted higher than body overlap — a query term appearing in the
    // document's own title/winery/region/grape metadata is a much stronger
    // "this document is actually about that" signal than merely containing
    // the word somewhere in a long body of text. Also IDF-scaled: a rare
    // term matching the title should count for more than a common one
    // matching the title, same reasoning as the body score above.
    for (const token of significantTokens) {
        if (metaText.includes(token)) score += (idf.get(token) || DEFAULT_IDF_WEIGHT) * 4;
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
    let candidates = index.chunks.filter((chunk) => chunk.metadata.enabled !== false);
    if (language) {
        candidates = candidates.filter((chunk) => !chunk.metadata.language || chunk.metadata.language === language);
    }

    const idf = buildIdfIndex(index);
    const scored = candidates
        .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk, idf) }))
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

    // Master kill switch (Dashboard "Search mode" = Disabled) — used to
    // verify the assistant genuinely has no knowledge-base access at all
    // (as opposed to just answering badly), independent of per-source
    // enable/disable. Never even touches the index.
    if (searchMode.getMode() === 'disabled') {
        return { hits: [], tookMs: Date.now() - startedAt, mode: 'disabled' };
    }

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

        // enabled:false chunks are still present in keyword.index.chunks
        // (so the Dashboard can list/re-enable them) but must never be
        // resolvable as a search hit — semantic candidates come straight
        // from Postgres, which doesn't know about the enabled flag at all.
        const chunkById = new Map(
            keyword.index.chunks.filter((c) => c.metadata.enabled !== false).map((c) => [c.id, c])
        );
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

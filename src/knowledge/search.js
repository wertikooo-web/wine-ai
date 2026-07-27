'use strict';

const { loadIndex } = require('./index');
const searchMode = require('./searchMode');
const db = require('./db');
const embeddings = require('./embeddings');
const { resolveEntity, getAliasesForEntity, buildAliasContext } = require('./entityResolver');

let lastSemanticError = null;

function getLastSemanticError() {
  return lastSemanticError;
}

function tokenize(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 2);
}

function tokenizeEntity(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

const SCORING_STOPWORDS = new Set([
    'despre', 'care', 'este', 'și', 'un', 'o', 'la', 'de', 'în', 'cu', 'ce', 'sau',
    'the', 'and', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'with', 'that', 'this',
    'о', 'об', 'что', 'это', 'как', 'для', 'на', 'из', 'или', 'вы', 'же',
    'по', 'не', 'от', 'за', 'но', 'со', 'этот', 'до', 'его', 'чем', 'при', 'более', 'также',
    'you', 'also', 'like', 'may', 'by',
]);

let idfCache = { builtAt: null, idf: null };

function buildIdfIndex(index) {
    if (idfCache.builtAt === index.built_at && idfCache.idf) return idfCache.idf;
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

const DEFAULT_IDF_WEIGHT = 1;

function scoreChunk(queryTokens, chunk, idf, { skipStopwords } = {}) {
    const significantTokens = skipStopwords ? queryTokens : queryTokens.filter((t) => !SCORING_STOPWORDS.has(t));
    if (significantTokens.length === 0) return 0;
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
    for (const token of significantTokens) {
        if (metaText.includes(token)) score += (idf.get(token) || DEFAULT_IDF_WEIGHT) * 4;
    }
    return score;
}

function keywordSearch(query, { limit, language, indexFile } = {}) {
    const startedAt = Date.now();
    const entityQuery = resolveEntity(query).found;
    const queryTokens = entityQuery ? tokenizeEntity(query) : tokenize(query);
    if (queryTokens.length === 0) {
        return { hits: [], tookMs: Date.now() - startedAt, index: null, entityQuery };
    }

    const index = loadIndex(indexFile);
    const candidates = index.chunks.filter((chunk) => chunk.metadata.enabled !== false);

    const idf = buildIdfIndex(index);
    const scored = candidates
        .map((chunk) => {
            const raw = scoreChunk(queryTokens, chunk, idf, { skipStopwords: entityQuery });
            let score = raw > 0 ? raw : 0;

            if (language && chunk.metadata.language) {
                if (chunk.metadata.language === language) {
                    score *= 1.5;
                } else {
                    score *= 0.8;
                }
            }

            return { chunk, score };
        })
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return { hits: scored, tookMs: Date.now() - startedAt, index, entityQuery };
}

const SEMANTIC_MAX_DISTANCE = 0.6;

async function semanticCandidateIds(query, { limit }) {
    if (!db.isEnabled() || !embeddings.isEnabled()) return null;
    const pool = db.getPool();
    if (!pool) return null;

    const queryVector = await embeddings.embedText(query, { taskType: 'RETRIEVAL_QUERY' });
    const vectorLiteral = `[${queryVector.join(',')}]`;
    const { rows } = await pool.query(
        `SELECT chunk_id, embedding <=> $1 AS distance
         FROM knowledge_chunk_embeddings
         WHERE embedding IS NOT NULL AND embedding <=> $1 < $3
         ORDER BY embedding <=> $1
         LIMIT $2;`,
        [vectorLiteral, limit, SEMANTIC_MAX_DISTANCE]
    );
    return rows.map((r) => r.chunk_id);
}

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

function aliasTextSearch(query, { index, resolved, limit }) {
    const aliases = getAliasesForEntity(resolved.entityId);
    if (aliases.length === 0) return { hits: [] };

    const aliasPatterns = [...new Set(aliases.map((a) => a.toLowerCase()))];
    const seen = new Set();
    const hits = [];

    for (const chunk of index.chunks) {
        if (chunk.metadata.enabled === false) continue;
        if (seen.has(chunk.id)) continue;
        const textLower = chunk.text.toLowerCase();
        const metaLower = [
            chunk.metadata.title, chunk.metadata.winery,
            chunk.metadata.region, chunk.metadata.grape,
        ].filter(Boolean).join(' ').toLowerCase();
        const combined = textLower + ' ' + metaLower;

        let aliasScore = 0;
        for (const pattern of aliasPatterns) {
            if (pattern.length < 3) continue;
            if (combined.includes(pattern)) {
                aliasScore = Math.max(aliasScore, 10 - (pattern.length / combined.length) * 5);
            }
        }

        if (aliasScore > 0) {
            seen.add(chunk.id);
            hits.push({ chunk, score: aliasScore });
        }
    }

    hits.sort((a, b) => b.score - a.score);
    return { hits: hits.slice(0, limit) };
}

function entityIdSearch(query, { index, resolved, limit }) {
    const candidates = index.chunks.filter(
        (c) => c.metadata.entity_id === resolved.entityId && c.metadata.enabled !== false
    );
    if (candidates.length === 0) return { hits: [] };

    const queryLower = query.toLowerCase();
    const aliasLower = (resolved.matchedAlias || '').toLowerCase();
    const entityLower = (resolved.entityId || '').toLowerCase();
    const topicQuery = queryLower
        .replace(new RegExp(aliasLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
        .replace(new RegExp(entityLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '')
        .replace(/\b(расскажи|про|что|такое|где|находится|какой|какие|как|сколько|расскажите|tell|about|where|what|which|how)\b/gi, ' ')
        .replace(/[?!.,:;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const topicTokens = tokenize(topicQuery);

    const scored = candidates.map((chunk) => {
        let score = 10;
        const titleLower = (chunk.metadata.title || '').toLowerCase();
        if (titleLower === queryLower) score += 100;
        else if (titleLower.includes(queryLower)) score += 50;
        if ((chunk.metadata.winery || '').toLowerCase().includes(queryLower)) score += 30;

        const bodyTokens = new Set(tokenize(chunk.text));
        const fullQueryTokens = tokenizeEntity(query);
        const fullMatched = fullQueryTokens.filter((t) => bodyTokens.has(t)).length;
        score += (fullMatched / Math.max(fullQueryTokens.length, 1)) * 10;

        if (topicTokens.length > 0) {
            const topicMatched = topicTokens.filter((t) => bodyTokens.has(t)).length;
            score += (topicMatched / Math.max(topicTokens.length, 1)) * 30;
        }

        if (chunk.text.toLowerCase().includes('адрес') || chunk.text.toLowerCase().includes('address') || chunk.text.toLowerCase().includes('str.')) {
            const locationQuery = /(адрес|где|находится|address|where|located|str\.|ул\.)/i.test(query);
            if (locationQuery) score += 40;
        }

        return { chunk, score: Math.max(1, score) };
    });

    scored.sort((a, b) => b.score - a.score);
    return { hits: scored.slice(0, limit) };
}

function evidenceSufficient(entityHits, resolved) {
    if (entityHits.length === 0) return false;
    if (resolved && resolved.confidence >= 0.9 && entityHits.length >= 1) return true;
    if (entityHits.length >= 2) return true;
    const topScore = entityHits[0].score;
    if (topScore >= 5) return true;
    return false;
}

function _buildDiagnostics() {
    return {
        requestedMode: searchMode.getMode(),
        actualMode: null,
        entityMatch: false,
        entityMatchType: null,
        semanticCandidateCount: null,
        semanticTookMs: null,
        semanticError: null,
        fallbackReason: null,
        rerankCandidateCount: null,
    };
}

async function search(query, { limit = 4, language = null, indexFile } = {}) {
    const startedAt = Date.now();
    const diag = _buildDiagnostics();

    if (searchMode.getMode() === 'disabled') {
        diag.actualMode = 'disabled';
        return { hits: [], tookMs: Date.now() - startedAt, mode: 'disabled', diagnostics: diag };
    }

    const index = loadIndex(indexFile);
    if (!index.chunks || index.chunks.length === 0) {
        diag.actualMode = 'keyword';
        return { hits: [], tookMs: Date.now() - startedAt, mode: 'keyword', diagnostics: diag };
    }

    const resolved = resolveEntity(query);
    diag.entityMatch = resolved.found;
    diag.entityMatchType = resolved.matchType || null;

    if (resolved.found) {
        const startStep = Date.now();

        const aliasHits = aliasTextSearch(query, { index, resolved, limit });
        const entityHits = entityIdSearch(query, { index, resolved, limit });

        const seen = new Set();
        const merged = [];
        for (const hit of [...entityHits.hits, ...aliasHits.hits]) {
            if (seen.has(hit.chunk.id)) continue;
            seen.add(hit.chunk.id);
            merged.push(hit);
        }
        merged.sort((a, b) => b.score - a.score);

        if (evidenceSufficient(merged, resolved)) {
            diag.actualMode = 'entity';
            return {
                hits: merged.slice(0, limit),
                tookMs: Date.now() - startedAt,
                mode: 'entity',
                entityResolved: resolved,
                entityContext: buildAliasContext(resolved),
                diagnostics: diag,
            };
        }

        diag.fallbackReason = 'entity_evidence_insufficient';
    }

    const keyword = keywordSearch(query, { limit, language, indexFile });
    diag.keywordTookMs = Date.now() - startedAt;

    const wantsHybrid = searchMode.getMode() === 'hybrid';
    if (!wantsHybrid || !keyword.index) {
        diag.actualMode = 'keyword';
        return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword', diagnostics: diag };
    }

    const semStart = Date.now();
    let semanticIds = null;
    try {
        semanticIds = await semanticCandidateIds(query, { limit: limit * 3 });
        diag.semanticTookMs = Date.now() - semStart;
    } catch (err) {
        diag.semanticTookMs = Date.now() - semStart;
        diag.semanticError = err.message;
        diag.actualMode = 'keyword';
        lastSemanticError = err.message;
        console.error('[knowledge search] semantic branch failed, falling back to keyword-only:', err.message);
        return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword', diagnostics: diag };
    }

    if (!semanticIds || semanticIds.length === 0) {
        diag.semanticCandidateCount = 0;
        diag.actualMode = 'keyword';
        return { hits: keyword.hits, tookMs: Date.now() - startedAt, mode: 'keyword', diagnostics: diag };
    }

    diag.semanticCandidateCount = semanticIds.length;

    const chunkById = new Map(
        keyword.index.chunks.filter((c) => c.metadata.enabled !== false).map((c) => [c.id, c])
    );
    const keywordIds = keyword.hits.map((h) => h.chunk.id);
    const fusedIds = reciprocalRankFusion([keywordIds, semanticIds]).slice(0, limit * 2);

    const keywordScoreById = new Map(keyword.hits.map((h) => [h.chunk.id, h.score]));
    const semanticWeightById = new Map();
    semanticIds.forEach((id, rank) => {
        semanticWeightById.set(id, 1 / (rank + 1));
    });

    const reranked = fusedIds
        .map((id) => chunkById.get(id))
        .filter(Boolean)
        .map((chunk) => {
            const kwScore = keywordScoreById.get(chunk.id) || 0;
            const semWeight = semanticWeightById.get(chunk.id) || 0;

            let score = (kwScore > 0 ? Math.min(kwScore, 20) : 0) + semWeight * 2;

            if (resolved.found && chunk.metadata.entity_id === resolved.entityId) {
                score += 10;
            }

            return { chunk, score: Math.max(1, score) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    diag.rerankCandidateCount = fusedIds.length;
    diag.actualMode = 'hybrid';

    const result = { hits: reranked, tookMs: Date.now() - startedAt, mode: 'hybrid', diagnostics: diag };

    if (resolved.found) {
        result.entityResolved = resolved;
        result.entityContext = buildAliasContext(resolved);
    }

    return result;
}

module.exports = {
    tokenize,
    search,
    getLastSemanticError,
};

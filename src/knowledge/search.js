'use strict';

const { loadIndex, loadChunks, CHUNK_SOURCES, CHUNK_SOURCE_ENV } = require('./index');
const searchMode = require('./searchMode');
const db = require('./db');
const embeddings = require('./embeddings');
const { resolveEntity, resolveEntities, getAliasesForEntity, buildAliasContext } = require('./entityResolver');

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
    const enabledChunks = index.chunks.filter((c) => c.metadata.enabled !== false);
    for (const chunk of enabledChunks) {
        const uniqueTokens = new Set(tokenize(chunk.text));
        for (const token of uniqueTokens) {
            docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
        }
    }
    const totalChunks = enabledChunks.length || 1;
    const idf = new Map();
    for (const [token, df] of docFrequency) {
        idf.set(token, Math.log((totalChunks + 1) / (df + 1)) + 1);
    }
    idfCache = { builtAt: index.built_at, idf };
    return idf;
}

const DEFAULT_IDF_WEIGHT = 1;

// Normalized trust mapping: all known confidence values → bounded multiplier
// 'verified' is stronger than 'high'; 'demo' is excluded from production scoring
const TRUST_WEIGHTS = {
    verified: 1.25,
    high: 1.15,
    medium: 1.0,
    unverified: 0.9,
    demo: 0.5,  // severely penalized in production
};

// Freshness scoring: type-aware, not one-size-fits-all.
// Uses published_at when available; fetch time is only used for news where no pub date exists.
function _freshnessBoost(chunk) {
    const docType = (chunk.metadata.doc_type || '').toLowerCase();
    const pubDate = chunk.metadata.date || chunk.metadata.published_at;
    const fetchDate = chunk.metadata.updated_at;

    // History, grape profiles, region profiles: no freshness boost (stable facts)
    const stableTypes = ['grape_profile', 'region_profile', 'manual', 'internal_reference'];
    if (stableTypes.includes(docType)) return 0;

    // For news/events: use published date if available, else fetch date
    const dateStr = pubDate || (docType === 'news' ? fetchDate : null);
    if (!dateStr) return 0;

    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return 0;
        // Reject future dates (likely fetch-time artifacts)
        const ageMs = Date.now() - d.getTime();
        if (ageMs < 0) return 0;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays <= 30) return 2;
        if (ageDays <= 90) return 1;
        return 0;
    } catch { return 0; }
}

function scoreChunk(queryTokens, chunk, idf, { skipStopwords } = {}) {
    const significantTokens = skipStopwords ? queryTokens : queryTokens.filter((t) => !SCORING_STOPWORDS.has(t));
    if (significantTokens.length === 0) return 0;
    const bodyTokens = new Set(tokenize(chunk.text));
    let score = 0;
    for (const token of significantTokens) {
        if (bodyTokens.has(token)) score += idf.get(token) || DEFAULT_IDF_WEIGHT;
    }
    if (score === 0) return 0;

    // Metadata match bonus (title, winery, region, grape)
    const metaText = [chunk.metadata.title, chunk.metadata.winery, chunk.metadata.region, chunk.metadata.grape]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    for (const token of significantTokens) {
        if (metaText.includes(token)) score += (idf.get(token) || DEFAULT_IDF_WEIGHT) * 4;
    }

    // Freshness boost (type-aware)
    score += _freshnessBoost(chunk);

    return score;
}

function keywordSearch(query, { limit, language, indexFile, index: providedIndex } = {}) {
    const startedAt = Date.now();
    const entityQuery = resolveEntity(query).found;
    const queryTokens = entityQuery ? tokenizeEntity(query) : tokenize(query);
    if (queryTokens.length === 0) {
        return { hits: [], tookMs: Date.now() - startedAt, index: null, entityQuery };
    }

    const index = providedIndex || loadIndex(indexFile);
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
        `SELECT e.chunk_id, e.embedding <=> $1 AS distance
         FROM knowledge_chunk_embeddings e
         JOIN knowledge_chunks k ON k.chunk_id = e.chunk_id
         WHERE e.embedding IS NOT NULL
           AND (k.enabled IS NOT FALSE)
           AND e.embedding <=> $1 < $3
         ORDER BY e.embedding <=> $1
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

// Stricter evidence sufficiency: requires verified identity + meaningful evidence.
// One alias substring hit is NOT sufficient evidence.
function evidenceSufficient(entityHits, resolved) {
    if (entityHits.length === 0) return false;
    // Need at least 2 evidence hits, OR 1 hit with high entity-id match and topic coverage
    if (entityHits.length >= 2) return true;
    if (entityHits.length === 1) {
        const top = entityHits[0];
        // Entity-ID matched chunks with topic bonus are strong evidence
        if (top.score >= 20 && resolved && resolved.confidence >= 0.9) return true;
        return false;
    }
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
        chunkSource: null,
        chunkFallback: null,
    };
}

// Build per-hit diagnostic detail (only when diagnostics mode is enabled)
function _hitDiagnostic(chunk, { kwScore = 0, semWeight = 0, entityBonus = 0, freshnessBoost = 0, rerankerScore = 0, included = true, reason = null } = {}) {
    return {
        chunkId: chunk.id,
        title: chunk.metadata.title,
        entity_id: chunk.metadata.entity_id || null,
        source: chunk.metadata.source || null,
        confidence: chunk.metadata.confidence || null,
        language: chunk.metadata.language || null,
        keywordScore: Math.round(kwScore * 100) / 100,
        semanticScore: Math.round(semWeight * 100) / 100,
        entityBonus: Math.round(entityBonus * 100) / 100,
        freshnessBoost: Math.round(freshnessBoost * 100) / 100,
        rerankerScore: Math.round(rerankerScore * 100) / 100,
        finalScore: Math.round((kwScore + semWeight + entityBonus + freshnessBoost) * 100) / 100,
        included,
        reason,
    };
}

// Multi-entity search: search for each entity separately, then merge results.
// Ensures balanced evidence: each entity gets a minimum quota of results,
// preventing a more popular entity from dominating all top-k slots.
// Options:
//   - perEntityQuota: minimum number of results per entity (default: 2)
async function _multiEntitySearch(query, allMentions, { limit, language, indexFile, index: providedIndex }) {
    const perEntityQuota = Math.max(2, Math.ceil(limit / allMentions.length));
    const entityResults = [];

    const index = providedIndex || loadIndex(indexFile);

    // Search each entity independently
    for (const mention of allMentions) {
        const resolved = {
            found: true,
            entityId: mention.entityId,
            canonicalName: mention.canonicalName,
            matchedAlias: mention.matchedAlias,
        };

        const aliasHits = aliasTextSearch(query, { index, resolved, limit: perEntityQuota + 2 });
        const entityHits = entityIdSearch(query, { index, resolved, limit: perEntityQuota + 2 });

        // Merge and dedup per-entity results
        const seen = new Set();
        const merged = [];
        for (const hit of [...entityHits.hits, ...aliasHits.hits]) {
            if (!seen.has(hit.chunk.id)) {
                seen.add(hit.chunk.id);
                merged.push(hit);
            }
        }
        merged.sort((a, b) => b.score - a.score);

        entityResults.push({
            entityId: mention.entityId,
            canonicalName: mention.canonicalName,
            hits: merged.slice(0, perEntityQuota + 2), // keep extra for fallback
            hasSufficientEvidence: merged.length >= 2,
        });
    }

    // Balanced merge: interleave results from each entity, respecting quotas
    const allHits = [];
    const seenIds = new Set();

    // Round 1: fill each entity's quota
    for (const er of entityResults) {
        let added = 0;
        for (const hit of er.hits) {
            if (added >= perEntityQuota) break;
            if (!seenIds.has(hit.chunk.id)) {
                seenIds.add(hit.chunk.id);
                allHits.push(hit);
                added++;
            }
        }
    }

    // Round 2: fill remaining slots from any entity's surplus
    for (const er of entityResults) {
        for (const hit of er.hits) {
            if (allHits.length >= limit) break;
            if (!seenIds.has(hit.chunk.id)) {
                seenIds.add(hit.chunk.id);
                allHits.push(hit);
            }
        }
    }

    // Check for insufficient evidence on any entity
    const insufficientEvidence = entityResults
        .filter((er) => !er.hasSufficientEvidence)
        .map((er) => er.entityId);

    allHits.sort((a, b) => b.score - a.score);

    return {
        hits: allHits.slice(0, limit),
        evidenceByEntity: entityResults.map((er) => ({
            entityId: er.entityId,
            canonicalName: er.canonicalName,
            hitCount: er.hits.length,
            sufficient: er.hasSufficientEvidence,
        })),
        insufficientEvidence: insufficientEvidence.length > 0 ? insufficientEvidence : null,
    };
}

// Build an index-like object ({built_at, chunks}) from a chunk array so the
// existing keyword/entity/hybrid algorithms can operate on it unchanged.
// built_at is a stable fingerprint of the chunk set so the module-level IDF
// cache (buildIdfIndex) never serves stale statistics across different loads.
function _indexFromChunks(chunks) {
    const fingerprint = chunks.slice(0, 50).map((c) => c.id).join('|');
    return { built_at: `runtime:${chunks.length}:${fingerprint}`, chunk_count: chunks.length, chunks };
}

// Resolve the chunk source for this search. When chunkSource is explicitly
// requested (option or KNOWLEDGE_CHUNK_SOURCE env flag) the chunk set is
// loaded through loadChunks() (postgres|file|auto); otherwise search() keeps
// its historical file-only behavior byte-for-byte.
async function _resolveIndex({ chunkSource, indexFile }) {
    if (!chunkSource || !CHUNK_SOURCES.has(chunkSource)) {
        return { index: loadIndex(indexFile), loaded: null };
    }
    const loaded = await loadChunks({ source: chunkSource, indexFile });
    return { index: _indexFromChunks(loaded.chunks), loaded };
}

async function search(query, { limit = 4, language = null, indexFile, chunkSource, diagnostics: enableDiagnostics = false } = {}) {
    const startedAt = Date.now();
    const diag = _buildDiagnostics();

    if (searchMode.getMode() === 'disabled') {
        diag.actualMode = 'disabled';
        return { hits: [], tookMs: Date.now() - startedAt, mode: 'disabled', diagnostics: diag };
    }

    const effectiveChunkSource = chunkSource || (typeof process !== 'undefined' ? process.env[CHUNK_SOURCE_ENV] : null);
    const chunkResolution = await _resolveIndex({ chunkSource: effectiveChunkSource, indexFile });
    const index = chunkResolution.index;
    if (chunkResolution.loaded) {
        diag.chunkSource = chunkResolution.loaded.source;
        diag.chunkFallback = chunkResolution.loaded.fallback;
    }

    if (!index.chunks || index.chunks.length === 0) {
        diag.actualMode = 'keyword';
        return { hits: [], tookMs: Date.now() - startedAt, mode: 'keyword', diagnostics: diag };
    }

    const resolved = resolveEntity(query);
    diag.entityMatch = resolved.found;
    diag.entityMatchType = resolved.matchType || null;

    // Multi-entity path: if allMentions is present, search each entity separately
    if (resolved.found && resolved.allMentions && resolved.allMentions.length > 1) {
        const multiResult = await _multiEntitySearch(query, resolved.allMentions, { limit, language, indexFile, index });
        diag.actualMode = 'multi_entity';
        return {
            hits: multiResult.hits,
            tookMs: Date.now() - startedAt,
            mode: 'multi_entity',
            entityResolved: resolved,
            entityContext: buildAliasContext(resolved),
            evidenceByEntity: multiResult.evidenceByEntity,
            insufficientEvidence: multiResult.insufficientEvidence,
            diagnostics: diag,
        };
    }

    if (resolved.found) {
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

    const keyword = keywordSearch(query, { limit, language, indexFile, index });
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

            // Normalize keyword score to [0,1] range, then blend with semantic weight
            const maxKeywordScore = 20;
            const normalizedKw = kwScore > 0 ? Math.min(kwScore / maxKeywordScore, 1) : 0;
            let score = normalizedKw + semWeight;

            let entityBonus = 0;
            if (resolved.found && chunk.metadata.entity_id === resolved.entityId) {
                entityBonus = 2;
                score += entityBonus;
            }

            // Apply freshness to hybrid candidates too
            const freshnessBoost = _freshnessBoost(chunk);
            score += freshnessBoost;

            return {
                chunk,
                score: Math.max(0.1, score),
                _diag: enableDiagnostics ? {
                    kwScore: normalizedKw,
                    semWeight,
                    entityBonus,
                    freshnessBoost,
                    rerankerScore: score,
                } : undefined,
            };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    diag.rerankCandidateCount = fusedIds.length;
    diag.actualMode = 'hybrid';

    const result = { hits: reranked, tookMs: Date.now() - startedAt, mode: 'hybrid', diagnostics: diag };

    // When diagnostics mode is enabled, attach per-hit scoring breakdown
    if (enableDiagnostics) {
        result.hitDiagnostics = reranked.map((h) => _hitDiagnostic(h.chunk, h._diag));
        // Clean up internal _diag property
        for (const h of result.hits) { delete h._diag; }
    } else {
        // Clean up _diag even if diagnostics not exposed
        for (const h of result.hits) { delete h._diag; }
    }

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

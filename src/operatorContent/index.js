'use strict';

// Runtime for operator content (Recommendations / News).
//
// Hot path is synchronous and never waits on the database: the last loaded
// blocks live in memory and refresh in the background at most every
// REFRESH_MS; a save updates this process immediately (no redeploy). Expiry
// is evaluated at read time (active_from / active_until), so expired content
// stops affecting answers without any cleanup. Every entry point swallows
// its own failures: these layers are enhancements, never dependencies.

const { getOperatorContentStore, TYPES } = require('./operatorContentStore');
const { parseRecommendations, parseNews, topicsOf, stems, entitiesOf, NEWS_INTENT } = require('./parseOperatorContent');
const { applyPromotions, clampBoost, DEFAULT_PROMOTION_BOOST, MODES } = require('./promotionLayer');
const { getWineFacts } = require('../companion/companionWineFacts');
const { refreshIndex } = require('../companion/companionCatalog');
const { recordLinkEvent } = require('../analytics/linkEvents');

const REFRESH_MS = 15000;
const MAX_NEWS_ITEMS = 2;
const MIN_NEWS_SCORE = 3;

const state = { recommendations: null, news: null, factsById: new Map(), fetchedAt: 0, inFlight: null };

async function loadFacts(block) {
    const factsById = new Map();
    for (const promo of (block && block.parsed && block.parsed.promotions) || []) {
        const facts = await getWineFacts(promo.wineId);
        if (facts) factsById.set(promo.wineId, facts);
    }
    return factsById;
}

function refresh() {
    if (state.inFlight) return state.inFlight;
    state.fetchedAt = Date.now();
    state.inFlight = (async () => {
        try {
            const store = getOperatorContentStore();
            const [recommendations, news] = await Promise.all([store.get('recommendations'), store.get('news')]);
            state.recommendations = recommendations;
            state.news = news;
            state.factsById = await loadFacts(recommendations);
        } catch {
            // keep the last known blocks
        } finally {
            state.inFlight = null;
        }
    })();
    return state.inFlight;
}

function maybeRefresh() {
    if (Date.now() - state.fetchedAt > REFRESH_MS) refresh();
}

function isActive(block, now = Date.now()) {
    if (!block || block.enabled !== true) return false;
    if (block.activeFrom && now < Date.parse(block.activeFrom)) return false;
    if (block.activeUntil && now >= Date.parse(block.activeUntil)) return false;
    return true;
}

// For wineIntelligence.recommendWine(): null when nothing should run.
function getPromotionContext(now = Date.now()) {
    try {
        maybeRefresh();
        const block = state.recommendations;
        if (!isActive(block, now) || !MODES.includes(block.mode) || block.mode === 'off') return null;
        const promotions = (block.parsed && block.parsed.promotions) || [];
        if (!promotions.length) return null;
        return { mode: block.mode, boost: clampBoost(block.settings && block.settings.boost), promotions, factsById: state.factsById };
    } catch {
        return null;
    }
}

// Relevant active news for one query: entity (winery/wine) match, topic
// match ("дегустация" ↔ a new tasting programme), explicit "what's new"
// intent, word overlap. Unrelated items are never returned.
function findRelevantNews(query, { now = Date.now(), max = MAX_NEWS_ITEMS, entities: queryEntities } = {}) {
    try {
        maybeRefresh();
        const block = state.news;
        if (!isActive(block, now)) return [];
        const items = (block.parsed && block.parsed.items) || [];
        if (!items.length) return [];
        const text = String(query || '');
        const qEntities = queryEntities || entitiesOf(text);
        const qIds = new Set(qEntities.map((e) => e.id));
        const qWineries = new Set(qEntities.filter((e) => e.type === 'wine').map((e) => String(e.wineryName || '').toLowerCase()));
        const qTopics = new Set(topicsOf(text));
        const qStems = new Set(stems(text));
        const newsIntent = NEWS_INTENT.test(text);
        const scored = [];
        for (const item of items) {
            const entityHit = item.entities.some((e) => qIds.has(e.id) || (e.type === 'winery' && qWineries.has(String(e.name).toLowerCase())));
            const topicHit = item.topics.some((t) => qTopics.has(t));
            const overlap = item.stems.filter((s) => qStems.has(s)).length;
            let score = (entityHit ? 3 : 0) + (topicHit ? 2 : 0) + (overlap >= 2 ? 1 : 0);
            if (newsIntent && (entityHit || topicHit)) score += 1;
            // "Что нового?" with no entity: general news may answer it.
            if (newsIntent && !qEntities.length && !item.entities.length) score += 3;
            if (score >= MIN_NEWS_SCORE) scored.push({ item, score, entityHit, topicHit });
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, max).map(({ item, score, entityHit, topicHit }) => ({
            news_id: item.newsId,
            text: item.text,
            source_type: 'operator_news',
            updated_at: block.updatedAt || null,
            active_until: block.activeUntil || null,
            relevance: { score, entity: entityHit, topic: topicHit },
            entity_ids: item.entities.map((e) => e.id),
        }));
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------
// Save (Dashboard)
// ---------------------------------------------------------------------

function parseDate(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw Object.assign(new Error(`${field}_invalid`), { statusCode: 400 });
    return new Date(t).toISOString();
}

function validateInput(type, input) {
    if (!TYPES.includes(type)) throw Object.assign(new Error('type_invalid'), { statusCode: 400 });
    const body = input && typeof input === 'object' ? input : {};
    const rawText = typeof body.rawText === 'string' ? body.rawText : '';
    if (rawText.length > 10000) throw Object.assign(new Error('text_too_long'), { statusCode: 400 });
    const enabled = body.enabled === true;
    let mode = enabled ? 'on' : 'off';
    if (type === 'recommendations') {
        mode = MODES.includes(body.mode) ? body.mode : 'off';
    }
    const activeFrom = parseDate(body.activeFrom, 'activeFrom');
    const activeUntil = parseDate(body.activeUntil, 'activeUntil');
    if (activeFrom && activeUntil && Date.parse(activeUntil) <= Date.parse(activeFrom)) throw Object.assign(new Error('active_range_invalid'), { statusCode: 400 });
    const settings = {};
    if (type === 'recommendations') settings.boost = clampBoost(body.boost === undefined ? DEFAULT_PROMOTION_BOOST : body.boost);
    return { rawText, enabled, mode, activeFrom, activeUntil, settings };
}

async function save(type, input, { updatedBy = null, store = getOperatorContentStore() } = {}) {
    const clean = validateInput(type, input);
    await refreshIndex().catch(() => {});
    const prev = await store.get(type).catch(() => null);
    const version = prev ? prev.version : 0;
    const parsed = type === 'recommendations' ? parseRecommendations(clean.rawText, { version }) : parseNews(clean.rawText, { version });
    const block = await store.save({ id: type, type, ...clean, parsed, updatedBy });
    // This process applies the change at once; others within REFRESH_MS.
    state[type] = block;
    if (type === 'recommendations') state.factsById = await loadFacts(block);
    return block;
}

async function getBlocks({ store = getOperatorContentStore() } = {}) {
    const [recommendations, news] = await Promise.all([store.get('recommendations'), store.get('news')]);
    const now = Date.now();
    return {
        recommendations: recommendations ? { ...recommendations, active: isActive(recommendations, now) && recommendations.mode !== 'off' } : null,
        news: news ? { ...news, active: isActive(news, now) } : null,
        defaults: { boost: DEFAULT_PROMOTION_BOOST, modes: MODES },
        storage: store.backend,
    };
}

// ---------------------------------------------------------------------
// Analytics (shared link_events table; never throws, never blocks)
// ---------------------------------------------------------------------

function analyticsBase(toolContext) {
    try {
        const a = toolContext && typeof toolContext.analytics === 'function' ? toolContext.analytics() : {};
        return { sessionId: a.sessionId || null, channel: a.channel || 'lite', language: a.language || null, provider: a.provider || null };
    } catch {
        return { sessionId: null, channel: 'lite', language: null, provider: null };
    }
}

// One event per evaluated promotion: enough to answer, after a shadow run,
// "organic winner X, promoted Y, organic score, boost, hypothetical score,
// would the ranking change, why rejected" -- no transcript stored.
function recordRecommendationDecision(decision, toolContext) {
    try {
        if (!decision) return;
        const base = analyticsBase(toolContext);
        for (const p of decision.promotions) {
            const detail = JSON.stringify({
                m: decision.mode, b: decision.boost,
                ow: String(decision.organic_winner || '').slice(0, 40), os: decision.organic_winner_score,
                ps: p.organic_score, hs: p.hypothetical_score, pos: p.hypothetical_position,
                chg: decision.ranking_changed ? 1 : 0, x: p.exclusion_reason, l: base.language, pr: base.provider,
            });
            recordLinkEvent({
                event: 'recommendation_ranked', entityType: 'wine', entityId: p.wine_id, entityName: p.name,
                ctaType: 'none', sessionId: base.sessionId, channel: base.channel, detail: `${p.promotion_id}|${detail}`.slice(0, 200),
            });
        }
    } catch { /* analytics never affect the answer */ }
}

function recordNewsUsed(items, toolContext) {
    try {
        const base = analyticsBase(toolContext);
        for (const item of items || []) {
            recordLinkEvent({
                event: 'news_used', entityType: 'news', entityId: item.news_id, entityName: (item.entity_ids || [])[0] || null,
                ctaType: 'none', sessionId: base.sessionId, channel: base.channel,
                detail: JSON.stringify({ s: item.relevance.score, e: item.relevance.entity ? 1 : 0, t: item.relevance.topic ? 1 : 0, l: base.language, pr: base.provider }),
            });
        }
    } catch { /* analytics never affect the answer */ }
}

function resetForTests() {
    state.recommendations = null; state.news = null; state.factsById = new Map(); state.fetchedAt = Date.now(); state.inFlight = null;
}

module.exports = {
    getPromotionContext, applyPromotions, findRelevantNews, save, getBlocks, isActive, refresh,
    recordRecommendationDecision, recordNewsUsed, resetForTests, MAX_NEWS_ITEMS,
};

'use strict';

// Link analytics for the Visual Companion: which verified links were shown
// to participants, which were clicked, and which were asked for but missing.
//
// Events (fixed vocabulary, validated here):
//   link_resolved  -- the server found verified links for a named wine/winery
//   link_rendered  -- the client showed a card with a CTA
//   link_clicked   -- the participant clicked a CTA
//   link_missing   -- a link was asked for (or an entity named) with none verified
//   recommendation_ranked -- an operator promotion was evaluated for a
//                    recommendation (shadow/on); detail = promotion id + scores
//   news_used      -- an operator news item was attached to an answer
// Stored in Postgres (link_events) when DATABASE_URL is a real database,
// otherwise in memory. Writes are best effort: analytics never break a turn.

const LINK_EVENT_TYPES = Object.freeze(['link_resolved', 'link_rendered', 'link_clicked', 'link_missing']);
const EVENT_TYPES = Object.freeze([...LINK_EVENT_TYPES, 'recommendation_ranked', 'news_used', 'organic_pool_compared']);
const ENTITY_TYPES = Object.freeze(['wine', 'winery', 'news', 'unknown']);
const CTA_TYPES = Object.freeze(['BOOK_TOUR', 'WINERY_ON_WINEMD', 'VISIT_WINERY_SITE', 'BUY_OR_VIEW_ON_WINEMD', 'OPEN_MAP', 'VIEW_WINE', 'INSTAGRAM', 'FACEBOOK', 'none']);

function clean(value, limit) {
    if (value === undefined || value === null) return null;
    const text = String(value).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, limit) : null;
}

// Returns a normalized event or null (unknown vocabulary is rejected).
function validateEvent(input) {
    const e = input && typeof input === 'object' ? input : {};
    if (!EVENT_TYPES.includes(e.event)) return null;
    const entityType = ENTITY_TYPES.includes(e.entityType) ? e.entityType : 'unknown';
    const ctaType = CTA_TYPES.includes(e.ctaType) ? e.ctaType : 'none';
    const entityId = clean(e.entityId, 80);
    if (!entityId && e.event !== 'link_missing') return null;
    return {
        event: e.event,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: clean(e.entityName, 160),
        cta_type: ctaType,
        session_id: clean(e.sessionId, 80),
        channel: clean(e.channel, 20) || 'lite',
        detail: clean(e.detail, 200),
    };
}

function isPostgresUrl(value) {
    return /^postgres(ql)?:\/\//i.test(String(value || ''));
}

function createPostgresLinkEventStore(poolProvider = () => require('../knowledge/db').getPool()) {
    let ready = null;
    const pool = () => poolProvider();
    function init() {
        if (!ready) {
            ready = pool().query(`
                CREATE TABLE IF NOT EXISTS link_events (
                    id BIGSERIAL PRIMARY KEY,
                    event TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT,
                    entity_name TEXT,
                    cta_type TEXT NOT NULL,
                    session_id TEXT,
                    channel TEXT,
                    detail TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_link_events_created ON link_events(created_at);
            `).catch((error) => { ready = null; throw error; });
        }
        return ready;
    }
    return {
        backend: 'postgres',
        async record(e) {
            await init();
            await pool().query(
                'INSERT INTO link_events (event, entity_type, entity_id, entity_name, cta_type, session_id, channel, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [e.event, e.entity_type, e.entity_id, e.entity_name, e.cta_type, e.session_id, e.channel, e.detail]
            );
        },
        async list({ sinceDays = 30 } = {}) {
            await init();
            const { rows } = await pool().query(
                `SELECT event, entity_type, entity_id, entity_name, cta_type, session_id, channel, detail, created_at FROM link_events
                 WHERE created_at > NOW() - ($1 || ' days')::interval ORDER BY created_at DESC LIMIT 20000`,
                [String(Math.max(1, Math.min(365, Number(sinceDays) || 30)))]
            );
            return rows;
        },
    };
}

function createMemoryLinkEventStore() {
    const rows = [];
    return {
        backend: 'memory',
        async record(e) { rows.unshift({ ...e, created_at: new Date().toISOString() }); if (rows.length > 20000) rows.pop(); },
        async list() { return rows.slice(); },
    };
}

let store = null;
function getLinkEventStore() {
    if (!store) store = isPostgresUrl(process.env.DATABASE_URL) ? createPostgresLinkEventStore() : createMemoryLinkEventStore();
    return store;
}
function setLinkEventStoreForTests(s) { store = s; }

// Best effort; never throws.
function recordLinkEvent(input, log = () => {}) {
    const e = validateEvent(input);
    if (!e) return false;
    log('link_event', e);
    Promise.resolve().then(() => getLinkEventStore().record(e)).catch((error) => {
        console.warn('[LinkEvents] record_failed', String(error && error.message).slice(0, 120));
    });
    return true;
}

// Demo analytics: per entity rendered / clicked / CTR, per CTA type, and the
// most requested missing links.
function summarize(rows) {
    const entities = new Map();
    const byCta = {};
    const missing = new Map();
    const sessions = new Set();
    const totals = { link_resolved: 0, link_rendered: 0, link_clicked: 0, link_missing: 0 };
    for (const r of rows) {
        // Operator-content events have their own summary (summarizeOperatorContent).
        if (!LINK_EVENT_TYPES.includes(r.event)) continue;
        totals[r.event] = (totals[r.event] || 0) + 1;
        if (r.session_id) sessions.add(r.session_id);
        if (r.event === 'link_missing') {
            const key = r.entity_name || r.entity_id || r.detail || 'unknown';
            missing.set(key, (missing.get(key) || 0) + 1);
            continue;
        }
        const key = `${r.entity_type}:${r.entity_id}`;
        const row = entities.get(key) || { entityType: r.entity_type, entityId: r.entity_id, name: r.entity_name, resolved: 0, rendered: 0, clicked: 0, clicksByCta: {} };
        if (r.event === 'link_resolved') row.resolved += 1;
        if (r.event === 'link_rendered') row.rendered += 1;
        if (r.event === 'link_clicked') {
            row.clicked += 1;
            row.clicksByCta[r.cta_type] = (row.clicksByCta[r.cta_type] || 0) + 1;
            byCta[r.cta_type] = byCta[r.cta_type] || { rendered: 0, clicked: 0 };
            byCta[r.cta_type].clicked += 1;
        }
        if (r.event === 'link_rendered') {
            byCta[r.cta_type] = byCta[r.cta_type] || { rendered: 0, clicked: 0 };
            byCta[r.cta_type].rendered += 1;
        }
        if (!row.name && r.entity_name) row.name = r.entity_name;
        entities.set(key, row);
    }
    const ctr = (clicked, rendered) => (rendered ? Math.round((clicked / rendered) * 1000) / 10 : null);
    return {
        totals,
        sessions: sessions.size,
        entities: [...entities.values()].map((e) => ({ ...e, ctrPct: ctr(e.clicked, e.rendered) })).sort((a, b) => b.clicked - a.clicked || b.rendered - a.rendered),
        byCta: Object.fromEntries(Object.entries(byCta).map(([k, v]) => [k, { ...v, ctrPct: ctr(v.clicked, v.rendered) }])),
        missing: [...missing.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 50),
    };
}

// Operator content: per promotion, how often it was evaluated, eligible,
// would have changed / changed the ranking, and why it was rejected; per
// news item, how often it was used. Reads the same link_events rows.
function parseRankedDetail(detail) {
    const text = String(detail || '');
    const bar = text.indexOf('|');
    try { return { promotionId: bar > 0 ? text.slice(0, bar) : null, ...JSON.parse(bar > 0 ? text.slice(bar + 1) : text) }; } catch { return { promotionId: bar > 0 ? text.slice(0, bar) : null }; }
}

function summarizeOperatorContent(rows) {
    const promotions = new Map();
    const news = new Map();
    for (const r of rows) {
        if (r.event === 'recommendation_ranked') {
            const d = parseRankedDetail(r.detail);
            const key = r.entity_id;
            const row = promotions.get(key) || { wineId: r.entity_id, name: r.entity_name, evaluated: 0, eligible: 0, wouldChange: 0, top1: 0, byMode: {}, exclusionReasons: {}, organicScores: [], hypotheticalScores: [], organicWinners: {} };
            row.evaluated += 1;
            row.byMode[d.m] = (row.byMode[d.m] || 0) + 1;
            if (d.x) row.exclusionReasons[d.x] = (row.exclusionReasons[d.x] || 0) + 1;
            else row.eligible += 1;
            if (d.chg) row.wouldChange += 1;
            if (d.pos === 1) row.top1 += 1;
            if (typeof d.ps === 'number') row.organicScores.push(d.ps);
            if (typeof d.hs === 'number') row.hypotheticalScores.push(d.hs);
            if (d.ow) row.organicWinners[d.ow] = (row.organicWinners[d.ow] || 0) + 1;
            promotions.set(key, row);
        } else if (r.event === 'news_used') {
            const row = news.get(r.entity_id) || { newsId: r.entity_id, used: 0, sessions: new Set() };
            row.used += 1;
            if (r.session_id) row.sessions.add(r.session_id);
            news.set(r.entity_id, row);
        }
    }
    const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
    // Fix A shadow: how often the verified wine.md pool would change the top 3.
    const pool = { compared: 0, changed: 0, byMode: {}, pooledTop: {}, organicTop: {}, eligibleAvg: null, samples: [] };
    const eligible = [];
    for (const r of rows) {
        if (r.event !== 'organic_pool_compared') continue;
        let d = {};
        try { d = JSON.parse(r.detail || '{}'); } catch { /* truncated detail */ }
        pool.compared += 1;
        if (d.chg) pool.changed += 1;
        pool.byMode[d.m || 'unknown'] = (pool.byMode[d.m || 'unknown'] || 0) + 1;
        if (Array.isArray(d.p) && d.p[0]) pool.pooledTop[d.p[0]] = (pool.pooledTop[d.p[0]] || 0) + 1;
        if (Array.isArray(d.o) && d.o[0]) pool.organicTop[d.o[0]] = (pool.organicTop[d.o[0]] || 0) + 1;
        if (typeof d.n === 'number') eligible.push(d.n);
        if (pool.samples.length < 20) pool.samples.push({ at: r.created_at, organic: d.o || [], pooled: d.p || [], changed: Boolean(d.chg), eligible: d.n, prefs: d.q || null });
    }
    pool.eligibleAvg = avg(eligible);
    return {
        catalogPool: pool,
        promotions: [...promotions.values()].map((p) => ({ ...p, avgOrganicScore: avg(p.organicScores), avgHypotheticalScore: avg(p.hypotheticalScores), organicScores: undefined, hypotheticalScores: undefined })),
        news: [...news.values()].map((n) => ({ newsId: n.newsId, used: n.used, sessions: n.sessions.size })),
    };
}

module.exports = { EVENT_TYPES, LINK_EVENT_TYPES, summarizeOperatorContent, CTA_TYPES, validateEvent, recordLinkEvent, summarize, getLinkEventStore, setLinkEventStoreForTests, createMemoryLinkEventStore };

'use strict';

// Link analytics for the Visual Companion: which verified links were shown
// to participants, which were clicked, and which were asked for but missing.
//
// Events (fixed vocabulary, validated here):
//   link_resolved  -- the server found verified links for a named wine/winery
//   link_rendered  -- the client showed a card with a CTA
//   link_clicked   -- the participant clicked a CTA
//   link_missing   -- a link was asked for (or an entity named) with none verified
// Stored in Postgres (link_events) when DATABASE_URL is a real database,
// otherwise in memory. Writes are best effort: analytics never break a turn.

const EVENT_TYPES = Object.freeze(['link_resolved', 'link_rendered', 'link_clicked', 'link_missing']);
const ENTITY_TYPES = Object.freeze(['wine', 'winery', 'unknown']);
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

module.exports = { EVENT_TYPES, CTA_TYPES, validateEvent, recordLinkEvent, summarize, getLinkEventStore, setLinkEventStoreForTests, createMemoryLinkEventStore };

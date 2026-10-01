'use strict';

// Visual Companion wine catalog: the ONLY source of wine cards, images and
// clickable actions shown to Wine AI Lite participants.
//
// - Records are imported from partner data (WineMD) by an operator; nothing
//   here is seeded, and the demo catalog (src/visual/visualCatalog.js) is
//   never used.
// - Every URL is validated at import (https only, no credentials, no
//   example/test/local hosts, optional host allowlist) and again when served.
//   The model never supplies a URL: the client resolves cards by wine id and
//   renders only the CTAs this module returns.
// - Public projection returns only fields that exist (no "Vintage: null").

const crypto = require('crypto');
const db = require('../knowledge/db');

const CTA_TYPES = Object.freeze({
    VIEW_WINE: 'VIEW_WINE',
    BUY_OR_VIEW_ON_WINEMD: 'BUY_OR_VIEW_ON_WINEMD',
    VISIT_WINERY_SITE: 'VISIT_WINERY_SITE',
    OPEN_MAP: 'OPEN_MAP',
});
const CTA_FROM_FIELD = Object.freeze([
    ['productUrl', CTA_TYPES.BUY_OR_VIEW_ON_WINEMD],
    ['wineryUrl', CTA_TYPES.VISIT_WINERY_SITE],
    ['mapUrl', CTA_TYPES.OPEN_MAP],
]);
const URL_FIELDS = Object.freeze(['imageUrl', 'productUrl', 'wineryUrl', 'mapUrl']);
const STRING_LIMITS = Object.freeze({
    externalId: 80, wineryId: 80, wineryName: 160, wineName: 200, type: 40, sweetness: 40, sweetnessSource: 20, region: 120,
    servingTemperature: 40, shortDescription: 600, tastingNotes: 1200,
});
const LIST_FIELDS = Object.freeze({ grapes: 12, foodPairings: 12, aliases: 8 });
const CURRENCIES = Object.freeze(['MDL', 'EUR', 'USD']);
const BLOCKED_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|test|invalid|local)$/i;

function allowedHosts() {
    return String(process.env.COMPANION_URL_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host, allowlist = allowedHosts()) {
    if (!allowlist.length) return true;
    return allowlist.some((rule) => (rule.startsWith('*.') ? host === rule.slice(2) || host.endsWith(rule.slice(1)) : host === rule));
}

// Returns a normalized https URL string or null.
function safeHttpsUrl(value, { allowlist } = {}) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) return null;
    let url;
    try { url = new URL(value.trim()); } catch { return null; }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || BLOCKED_HOSTS.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return null;
    if (!hostAllowed(host, allowlist)) return null;
    return url.toString();
}

function cleanString(value, limit) {
    if (value === undefined || value === null) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, limit) : null;
}

function cleanList(value, limit) {
    if (!Array.isArray(value)) return null;
    const list = [...new Set(value.map((v) => cleanString(v, 80)).filter(Boolean))].slice(0, limit);
    return list.length ? list : null;
}

function recordId(input) {
    if (typeof input.wineId === 'string' && /^cw_[a-z0-9_-]{4,60}$/i.test(input.wineId)) return input.wineId;
    const basis = input.externalId ? `sku:${input.externalId}` : `name:${input.wineryName}|${input.wineName}|${input.vintage || ''}`;
    return `cw_${crypto.createHash('sha256').update(String(basis).toLowerCase()).digest('hex').slice(0, 16)}`;
}

// Validates one partner record. Unsafe URLs are errors (the record is
// rejected), never silently kept.
function validateRecord(input) {
    const errors = [];
    const r = input && typeof input === 'object' ? input : {};
    const out = {};
    for (const [field, limit] of Object.entries(STRING_LIMITS)) {
        const v = cleanString(r[field], limit);
        if (v) out[field] = v;
    }
    if (!out.wineName) errors.push('wineName_required');
    if (!out.wineryName) errors.push('wineryName_required');
    if (/^demo/i.test(String(r.wineId || '')) || /^demo/i.test(String(out.externalId || ''))) errors.push('demo_record_rejected');
    if (r.vintage !== undefined && r.vintage !== null && r.vintage !== '') {
        const y = Number(r.vintage);
        if (Number.isInteger(y) && y >= 1900 && y <= 2100) out.vintage = y;
        else errors.push('vintage_invalid');
    }
    if (r.alcohol !== undefined && r.alcohol !== null && r.alcohol !== '') {
        const a = Number(r.alcohol);
        if (Number.isFinite(a) && a > 0 && a < 30) out.alcohol = a;
        else errors.push('alcohol_invalid');
    }
    for (const [field, limit] of Object.entries(LIST_FIELDS)) {
        const v = cleanList(r[field], limit);
        if (v) out[field] = v;
    }
    for (const field of URL_FIELDS) {
        if (r[field] === undefined || r[field] === null || r[field] === '') continue;
        const safe = safeHttpsUrl(r[field]);
        if (safe) out[field] = safe;
        else errors.push(`${field}_unsafe`);
    }
    if (r.price !== undefined && r.price !== null && r.price !== '') {
        const p = Number(r.price);
        const currency = String(r.currency || '').toUpperCase();
        if (Number.isFinite(p) && p > 0 && CURRENCIES.includes(currency)) { out.price = p; out.currency = currency; } else errors.push('price_invalid');
    }
    if (errors.length) return { record: null, errors };
    out.wineId = recordId({ ...r, ...out });
    return { record: out, errors };
}

// Participant-facing projection: present fields only + approved CTAs.
function publicCard(record) {
    if (!record) return null;
    const card = { wineId: record.wineId };
    for (const key of ['wineryName', 'wineName', 'vintage', 'type', 'sweetness', 'grapes', 'region', 'alcohol', 'servingTemperature', 'shortDescription', 'tastingNotes', 'foodPairings', 'price', 'currency']) {
        if (record[key] !== undefined && record[key] !== null) card[key] = record[key];
    }
    const image = safeHttpsUrl(record.imageUrl);
    if (image) card.imageUrl = image;
    card.ctas = CTA_FROM_FIELD
        .map(([field, type]) => ({ type, url: safeHttpsUrl(record[field]) }))
        .filter((cta) => cta.url);
    return card;
}

function normalizeName(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[şș]/g, 's').replace(/[ţț]/g, 't').replace(/[^a-z0-9а-яё]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Names a message must contain for the card to be shown (see
// public/lite-companion.js). Full wine name, winery + name, and aliases;
// names shorter than 6 characters are not used on their own.
function matchNames(record) {
    const names = [record.wineName, `${record.wineryName} ${record.wineName}`, ...(record.aliases || [])];
    return [...new Set(names.map(normalizeName).filter((n) => n.length >= 6))];
}

// ---------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------

function createPostgresCompanionStore(poolProvider = () => db.getPool()) {
    let ready = null;
    const pool = () => {
        const p = poolProvider();
        if (!p) throw Object.assign(new Error('companion_store_unavailable'), { code: 'companion_store_unavailable' });
        return p;
    };
    const init = () => {
        if (!ready) {
            ready = pool().query(`
                CREATE TABLE IF NOT EXISTS companion_wines (
                    wine_id TEXT PRIMARY KEY,
                    external_id TEXT,
                    record JSONB NOT NULL,
                    published BOOLEAN NOT NULL DEFAULT TRUE,
                    source TEXT,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `).catch((error) => { ready = null; throw error; });
        }
        return ready;
    };
    return {
        backend: 'postgres',
        init,
        async upsert(record, { published = true, source = 'import' } = {}) {
            await init();
            await pool().query(
                `INSERT INTO companion_wines (wine_id, external_id, record, published, source) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (wine_id) DO UPDATE SET external_id = EXCLUDED.external_id, record = EXCLUDED.record, published = EXCLUDED.published, source = EXCLUDED.source, updated_at = NOW()`,
                [record.wineId, record.externalId || null, JSON.stringify(record), published, source],
            );
        },
        async setPublished(wineId, published) {
            await init();
            const result = await pool().query('UPDATE companion_wines SET published = $2, updated_at = NOW() WHERE wine_id = $1', [wineId, published]);
            return result.rowCount === 1;
        },
        async list({ publishedOnly = true } = {}) {
            await init();
            const { rows } = await pool().query(`SELECT record, published FROM companion_wines ${publishedOnly ? 'WHERE published' : ''} ORDER BY updated_at DESC LIMIT 2000`);
            return rows.map((r) => ({ ...r.record, published: r.published }));
        },
        async get(wineId) {
            await init();
            const { rows } = await pool().query('SELECT record FROM companion_wines WHERE wine_id = $1 AND published', [wineId]);
            return rows[0] ? rows[0].record : null;
        },
    };
}

function createMemoryCompanionStore() {
    const rows = new Map();
    const copy = (v) => JSON.parse(JSON.stringify(v));
    return {
        backend: 'memory',
        async init() {},
        async upsert(record, { published = true } = {}) { rows.set(record.wineId, { record: copy(record), published }); },
        async setPublished(wineId, published) { const r = rows.get(wineId); if (!r) return false; r.published = published; return true; },
        async list({ publishedOnly = true } = {}) { return [...rows.values()].filter((r) => !publishedOnly || r.published).map((r) => ({ ...copy(r.record), published: r.published })); },
        async get(wineId) { const r = rows.get(wineId); return r && r.published ? copy(r.record) : null; },
    };
}

function isPostgresConfigured() {
    return db.isEnabled() && process.env.DATABASE_URL !== 'memory';
}

let defaultStore = null;
function getCompanionStore() {
    if (!defaultStore) defaultStore = isPostgresConfigured() ? createPostgresCompanionStore() : createMemoryCompanionStore();
    return defaultStore;
}
function setCompanionStoreForTests(store) { defaultStore = store; resetIndexCache(); }

// Synchronous, cached index for the knowledge tool (never waits on the DB).
let indexCache = [];
let indexFetchedAt = 0;
let indexInFlight = null;
function resetIndexCache() { indexCache = []; indexFetchedAt = 0; indexInFlight = null; }
function refreshIndex() {
    if (indexInFlight) return indexInFlight;
    indexFetchedAt = Date.now();
    indexInFlight = getCompanionStore().list({ publishedOnly: true })
        .then((records) => { indexCache = records.map((r) => ({ wineId: r.wineId, wineName: r.wineName, wineryName: r.wineryName, names: matchNames(r) })); })
        .catch(() => { /* keep last index */ })
        .finally(() => { indexInFlight = null; });
    return indexInFlight;
}
function getIndexSync() {
    if (Date.now() - indexFetchedAt > 30000) refreshIndex();
    return indexCache;
}

// Catalog wines named in any of the given texts (query, evidence, answer).
function findWinesInTexts(texts, index = getIndexSync(), max = 3) {
    const haystack = ` ${texts.map(normalizeName).join(' ')} `;
    const found = [];
    for (const entry of index) {
        if (entry.names.some((name) => haystack.includes(` ${name} `))) found.push(entry);
        if (found.length >= max) break;
    }
    return found;
}

module.exports = {
    CTA_TYPES,
    URL_FIELDS,
    safeHttpsUrl,
    validateRecord,
    publicCard,
    normalizeName,
    matchNames,
    createPostgresCompanionStore,
    createMemoryCompanionStore,
    getCompanionStore,
    setCompanionStoreForTests,
    refreshIndex,
    getIndexSync,
    findWinesInTexts,
    resetIndexCache,
};

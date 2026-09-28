'use strict';

// /api/companion/* — Visual Companion catalog.
//   GET  /api/companion/catalog            published wines' ids + match names (Lite client)
//   GET  /api/companion/wines/:id          public card (present fields + approved CTAs)
//   GET  /api/companion/wines              operator list incl. unpublished
//   POST /api/companion/wines/import       operator import of partner records
//   POST /api/companion/wines/:id/published {published: bool}
// Operator writes require x-admin-token when ADMIN_TOKEN is set.

const crypto = require('crypto');
const { getCompanionStore, validateRecord, publicCard, matchNames, refreshIndex } = require('./companionCatalog');

function isWriteAllowed(req) {
    const token = process.env.ADMIN_TOKEN || '';
    if (!token) return true;
    const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const enabled = () => process.env.VISUAL_COMPANION_ENABLED !== 'false';

function createCompanionApi({ sendJson, readJsonBody, getStore = getCompanionStore }) {
    async function handle(req, res, pathname) {
        if (!pathname.startsWith('/api/companion/')) return false;
        const method = req.method;
        try {
            if (method === 'GET' && pathname === '/api/companion/catalog') {
                if (!enabled()) { sendJson(res, 200, { ok: true, enabled: false, wines: [] }); return true; }
                const records = await getStore().list({ publishedOnly: true });
                sendJson(res, 200, { ok: true, enabled: true, wines: records.map((r) => ({ wineId: r.wineId, names: matchNames(r) })) });
                return true;
            }
            const cardMatch = /^\/api\/companion\/wines\/(cw_[A-Za-z0-9_-]{4,60})$/.exec(pathname);
            if (method === 'GET' && cardMatch) {
                const record = enabled() ? await getStore().get(cardMatch[1]) : null;
                if (!record) { sendJson(res, 404, { ok: false, error: 'not_found' }); return true; }
                sendJson(res, 200, { ok: true, card: publicCard(record) });
                return true;
            }

            if (!isWriteAllowed(req)) { sendJson(res, 401, { ok: false, error: 'admin_token_required' }); return true; }

            if (method === 'GET' && pathname === '/api/companion/wines') {
                sendJson(res, 200, { ok: true, storage: getStore().backend, wines: await getStore().list({ publishedOnly: false }) });
                return true;
            }
            if (method === 'POST' && pathname === '/api/companion/wines/import') {
                const body = await readJsonBody(req, 2 * 1024 * 1024);
                const input = Array.isArray(body.wines) ? body.wines.slice(0, 500) : [];
                const published = body.published !== false;
                const imported = [];
                const rejected = [];
                for (const [index, raw] of input.entries()) {
                    const { record, errors } = validateRecord(raw);
                    if (!record) { rejected.push({ index, errors }); continue; }
                    await getStore().upsert(record, { published, source: String(body.source || 'import').slice(0, 40) });
                    imported.push({ wineId: record.wineId, wineName: record.wineName });
                }
                refreshIndex();
                sendJson(res, rejected.length && !imported.length ? 400 : 200, { ok: imported.length > 0 || input.length === 0, imported, rejected });
                return true;
            }
            const pubMatch = /^\/api\/companion\/wines\/(cw_[A-Za-z0-9_-]{4,60})\/published$/.exec(pathname);
            if (method === 'POST' && pubMatch) {
                const body = await readJsonBody(req);
                const changed = await getStore().setPublished(pubMatch[1], body.published === true);
                refreshIndex();
                sendJson(res, changed ? 200 : 404, { ok: changed });
                return true;
            }
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return true;
        } catch (error) {
            if (error?.code === 'invalid_json' || error?.code === 'body_too_large') {
                sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code });
                return true;
            }
            console.warn('[CompanionApi] request_failed', pathname, String(error?.message || error).slice(0, 200));
            sendJson(res, 503, { ok: false, error: 'companion_unavailable' });
            return true;
        }
    }
    return { handle };
}

module.exports = { createCompanionApi };

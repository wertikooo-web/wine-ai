'use strict';

// Internal Dashboard endpoints for Cost & Usage Control (/api/cost/*).
// Returns aggregates, raw normalized usage and MDL/EUR totals. Never returns
// API keys, prompts, transcripts or raw provider payloads.
//
// Writes (pricing, fixed costs, settings) require the x-admin-token header
// when ADMIN_TOKEN is configured; otherwise they follow the rest of the
// Dashboard's internal write endpoints.

const crypto = require('crypto');
const { getCostStore, sanitizeSettingsPatch, sanitizeFixedItem, isPostgresConfigured } = require('./costStore');
const { validatePricingRow, CATEGORY_LABELS } = require('./pricing');
const { buildSummary, buildCustomerSummary, periodBounds, zonedMidnight, priceRecord, totalsFor, breakdown, sessionView } = require('./costAggregation');
const { invalidatePricingCache, getTelemetryStats } = require('./costTelemetry');

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDateParam(value, timeZone, { endOfDay = false } = {}) {
    if (!value) return null;
    const s = String(value);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
        const start = zonedMidnight(Number(m[1]), Number(m[2]), Number(m[3]), timeZone);
        return endOfDay ? new Date(start.getTime() + DAY_MS - 1) : start;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

function resolveRange(searchParams, settings, now) {
    const tz = settings.timezone;
    const from = parseDateParam(searchParams.get('from'), tz);
    const to = parseDateParam(searchParams.get('to'), tz, { endOfDay: true });
    if (from === undefined || to === undefined) return { error: 'invalid_date' };
    if (!from && !to) return { range: null };
    const bounds = periodBounds(now, tz);
    const range = { from: from || bounds.month.from, to: to || new Date(now) };
    if (range.from > range.to) return { error: 'invalid_range' };
    if (range.to - range.from > 400 * DAY_MS) return { error: 'range_too_large' };
    return { range };
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isWriteAllowed(req) {
    const token = process.env.ADMIN_TOKEN || '';
    if (!token) return true;
    return safeEqual(req.headers['x-admin-token'] || '', token);
}

async function loadContext(store, now, range) {
    const [settings, pricingRows, fixedItems] = await Promise.all([store.getSettings(), store.listPricing(), store.listFixedItems()]);
    return { settings, pricingRows, fixedItems };
}

async function loadRecords(store, settings, now, range) {
    const bounds = periodBounds(now, settings.timezone);
    const from = new Date(Math.min(bounds.month.from.getTime(), bounds.last7.from.getTime(), range ? new Date(range.from).getTime() : Infinity));
    const to = new Date(Math.max(new Date(now).getTime() + 1, range ? new Date(range.to).getTime() + 1 : 0));
    return store.listUsageRecords({ from: from.toISOString(), to: to.toISOString() });
}

function createCostApi({ sendJson, readJsonBody, getStore = getCostStore, nowFn = () => Date.now() }) {
    async function summary(searchParams) {
        const store = getStore();
        const now = nowFn();
        const { settings, pricingRows, fixedItems } = await loadContext(store);
        const { range, error } = resolveRange(searchParams, settings, now);
        if (error) return { status: 400, body: { ok: false, error } };
        const records = await loadRecords(store, settings, now, range);
        const result = buildSummary({ records, pricingRows, fixedItems, settings, now, range });
        return { status: 200, body: { ok: true, storage: store.backend, ...result, customer_summary: buildCustomerSummary(result) } };
    }

    async function rangedRecords(searchParams) {
        const store = getStore();
        const now = nowFn();
        const { settings, pricingRows } = await loadContext(store);
        const resolved = resolveRange(searchParams, settings, now);
        if (resolved.error) return { error: resolved.error };
        const range = resolved.range || { from: periodBounds(now, settings.timezone).month.from, to: new Date(now) };
        const records = await store.listUsageRecords({ from: new Date(range.from).toISOString(), to: new Date(new Date(range.to).getTime() + 1).toISOString() });
        return { range, settings, priced: records.map((r) => priceRecord(r, pricingRows, settings)) };
    }

    async function handle(req, res, pathname, searchParams) {
        if (!pathname.startsWith('/api/cost/')) return false;
        const method = req.method;
        try {
            if (method === 'GET' && pathname === '/api/cost/summary') {
                const { status, body } = await summary(searchParams);
                sendJson(res, status, body);
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/customer-summary') {
                const { status, body } = await summary(new URLSearchParams());
                sendJson(res, status, status === 200 ? { ok: true, rates: body.rates, customer_summary: body.customer_summary } : body);
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/sessions') {
                const out = await rangedRecords(searchParams);
                if (out.error) { sendJson(res, 400, { ok: false, error: out.error }); return true; }
                const limit = Math.min(500, Math.max(1, Number(searchParams.get('limit')) || 100));
                const sessions = out.priced.filter((r) => r.kind === 'realtime_session');
                sendJson(res, 200, {
                    ok: true,
                    from: new Date(out.range.from).toISOString(),
                    to: new Date(out.range.to).toISOString(),
                    total: sessions.length,
                    totals: totalsFor(sessions, out.range.from, out.range.to),
                    sessions: sessions.slice(0, limit).map(sessionView),
                });
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/breakdown') {
                const out = await rangedRecords(searchParams);
                if (out.error) { sendJson(res, 400, { ok: false, error: out.error }); return true; }
                sendJson(res, 200, {
                    ok: true,
                    from: new Date(out.range.from).toISOString(),
                    to: new Date(out.range.to).toISOString(),
                    totals: totalsFor(out.priced, out.range.from, out.range.to),
                    ...breakdown(out.priced),
                    category_labels: CATEGORY_LABELS,
                });
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/pricing') {
                sendJson(res, 200, { ok: true, pricing: await getStore().listPricing(), category_labels: CATEGORY_LABELS });
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/fixed-costs') {
                sendJson(res, 200, { ok: true, fixed_costs: await getStore().listFixedItems() });
                return true;
            }
            if (method === 'GET' && pathname === '/api/cost/settings') {
                sendJson(res, 200, { ok: true, settings: await getStore().getSettings(), storage: getStore().backend, persistent: isPostgresConfigured(), telemetry: getTelemetryStats() });
                return true;
            }

            const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';
            if (isWrite && !isWriteAllowed(req)) {
                sendJson(res, 401, { ok: false, error: 'admin_token_required' });
                return true;
            }

            if ((method === 'POST' || method === 'PUT') && pathname === '/api/cost/pricing') {
                const body = await readJsonBody(req);
                const row = {
                    id: body.id ? String(body.id).slice(0, 120) : `${body.provider}:${body.model}:${body.category}@${body.effective_from}`,
                    provider: String(body.provider || '').trim(),
                    model: String(body.model || '').trim(),
                    category: String(body.category || '').trim(),
                    billing_unit: String(body.billing_unit || '').trim(),
                    currency: String(body.currency || 'USD').toUpperCase(),
                    unit_prices: body.unit_prices && typeof body.unit_prices === 'object'
                        ? Object.fromEntries(Object.entries(body.unit_prices).map(([k, v]) => [String(k).slice(0, 40), Number(v)]))
                        : null,
                    effective_from: body.effective_from ? String(body.effective_from).slice(0, 10) : '',
                    effective_to: body.effective_to ? String(body.effective_to).slice(0, 10) : null,
                    source_note: String(body.source_note || '').slice(0, 400),
                };
                const errors = validatePricingRow(row);
                if (errors.length) { sendJson(res, 400, { ok: false, error: 'invalid_pricing', details: errors }); return true; }
                await getStore().upsertPricing(row);
                invalidatePricingCache();
                sendJson(res, 200, { ok: true, pricing: row });
                return true;
            }
            if (method === 'POST' && pathname === '/api/cost/fixed-costs') {
                const body = await readJsonBody(req);
                const { item, errors } = sanitizeFixedItem(body);
                if (errors.length) { sendJson(res, 400, { ok: false, error: 'invalid_fixed_cost', details: errors }); return true; }
                await getStore().upsertFixedItem(item);
                sendJson(res, 200, { ok: true, fixed_cost: item });
                return true;
            }
            const fixedMatch = /^\/api\/cost\/fixed-costs\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
            if (fixedMatch && method === 'PUT') {
                const body = await readJsonBody(req);
                const { item, errors } = sanitizeFixedItem({ ...body, id: fixedMatch[1] });
                if (errors.length) { sendJson(res, 400, { ok: false, error: 'invalid_fixed_cost', details: errors }); return true; }
                await getStore().upsertFixedItem(item);
                sendJson(res, 200, { ok: true, fixed_cost: item });
                return true;
            }
            if (fixedMatch && method === 'DELETE') {
                const result = await getStore().deleteFixedItem(fixedMatch[1]);
                sendJson(res, result.deleted ? 200 : 404, { ok: result.deleted, error: result.deleted ? undefined : 'not_found' });
                return true;
            }
            if ((method === 'PUT' || method === 'POST') && pathname === '/api/cost/settings') {
                const body = await readJsonBody(req);
                const { patch, errors } = sanitizeSettingsPatch(body);
                if (errors.length) { sendJson(res, 400, { ok: false, error: 'invalid_settings', details: errors }); return true; }
                const settings = await getStore().updateSettings(patch);
                sendJson(res, 200, { ok: true, settings });
                return true;
            }
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return true;
        } catch (error) {
            if (error?.code === 'invalid_json' || error?.code === 'body_too_large') {
                sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code });
                return true;
            }
            console.warn('[CostApi] request_failed', pathname, String(error?.message || error).slice(0, 200));
            sendJson(res, 503, { ok: false, error: 'cost_data_unavailable' });
            return true;
        }
    }

    return { handle };
}

module.exports = { createCostApi, parseDateParam, resolveRange };

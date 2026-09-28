'use strict';

// Cost & Usage Control: pricing, conversion, aggregation, idempotency,
// missing usage metadata, DB-failure isolation, fixed costs, budget and API
// response shape. Pure/in-memory — no network, no real Postgres needed.
process.env.NO_SPEECH_MIN_LOUD_MS = '0';

const assert = require('assert');
const { resolvePrice, computeUsageCost, convert, DEFAULT_PRICING, validatePricingRow } = require('../src/cost/pricing');
const { normalizeGeminiUsage, normalizeRealtimeCompatUsage } = require('../src/cost/usageNormalize');
const { createSessionUsageMeter } = require('../src/cost/sessionUsageMeter');
const { buildSummary, budgetStatus, fixedCostsForMonth, periodBounds } = require('../src/cost/costAggregation');
const { createMemoryCostStore, setCostStoreForTests, sanitizeSettingsPatch, DEFAULT_SETTINGS } = require('../src/cost/costStore');
const costTelemetry = require('../src/cost/costTelemetry');
const { createCostApi } = require('../src/cost/costApi');

let assertions = 0;
const t = {
    ok(value, message) { assertions += 1; assert.ok(value, message); },
    equal(a, b, message) { assertions += 1; assert.strictEqual(a, b, message); },
    close(a, b, message, eps = 1e-9) { assertions += 1; assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} != ${b}`); },
    deepEqual(a, b, message) { assertions += 1; assert.deepStrictEqual(a, b, message); },
};

const RATES = { eur_to_mdl: 20, usd_to_eur: 0.5 };
const SETTINGS = { ...DEFAULT_SETTINGS, ...RATES, timezone: 'Europe/Chisinau', monthly_budget_mdl: 1000, warning_thresholds: [70, 90, 100] };

function sessionRecord(id, { at, provider = 'gemini', model = 'gemini-3.1-flash-live-preview', usage, basis = 'actual', turns = 1, durationMs = 60000 }) {
    return {
        record_id: `rt:${id}`, kind: 'realtime_session', session_id: id, occurred_at: at, ended_at: at,
        duration_ms: durationMs, category: provider === 'grok' ? 'realtime_grok' : 'realtime_gemini',
        provider, model, status: turns > 0 ? 'completed' : 'no_conversation', turn_count: turns,
        provider_connections: 1, usage, usage_basis: basis, usage_raw: {},
    };
}

function testCostCalculation() {
    const price = resolvePrice(DEFAULT_PRICING, { provider: 'gemini', model: 'gemini-3.1-flash-live-preview', category: 'realtime_gemini', at: '2026-09-10T10:00:00Z' });
    t.ok(price, 'gemini live price must resolve');
    const usage = { input_text_tokens: 1_000_000, input_audio_tokens: 1_000_000, output_text_tokens: 1_000_000, output_audio_tokens: 1_000_000 };
    const cost = computeUsageCost(usage, 'actual', price);
    t.close(cost.cost, 0.75 + 3 + 4.5 + 12, 'token cost = sum of modality prices');
    t.equal(cost.basis, 'actual', 'fully itemized provider usage stays ACTUAL');
    t.equal(cost.currency, 'USD', 'seed prices are USD list prices');

    const unitemized = computeUsageCost({ input_other_tokens: 1_000_000 }, 'actual', price);
    t.close(unitemized.cost, 3, 'unknown-modality input priced at the higher input rate');
    t.equal(unitemized.basis, 'estimated', 'unknown modality downgrades to ESTIMATED');

    const unpriced = computeUsageCost(usage, 'actual', resolvePrice(DEFAULT_PRICING, { provider: 'gemini', model: 'some-unknown-model', category: 'realtime_gemini', at: '2026-09-10' }));
    t.equal(unpriced.cost, null, 'unknown model is never guessed');
    t.equal(unpriced.priced, false, 'unknown model is reported as unpriced');

    const embedding = resolvePrice(DEFAULT_PRICING, { provider: 'gemini', model: 'gemini-embedding-001', category: 'embedding', at: '2026-09-10' });
    const emb = computeUsageCost({ input_chars: 4_000_000 }, 'estimated', embedding);
    t.close(emb.cost, 0.15, 'embedding chars converted with chars_per_token');
    t.equal(emb.basis, 'estimated', 'char-derived embedding cost is ESTIMATED');

    const grounding = resolvePrice(DEFAULT_PRICING, { provider: 'gemini', model: 'gemini-2.5-flash', category: 'web_search', at: '2026-09-10' });
    t.close(computeUsageCost({ requests: 2 }, 'actual', grounding).cost, 0.07, 'grounding priced per 1K requests');

    const invalid = validatePricingRow({ provider: 'x', model: 'y', category: 'llm_text', billing_unit: 'bogus', effective_from: '2026-1-1', unit_prices: { a: -1 } });
    t.ok(invalid.includes('billing_unit_invalid') && invalid.includes('effective_from_invalid') && invalid.includes('unit_prices.a_invalid'), 'invalid pricing rows rejected');
}

function testPricingEffectiveDates() {
    const before = resolvePrice(DEFAULT_PRICING, { provider: 'grok', model: 'grok-voice-latest', category: 'realtime_grok', at: '2026-08-04T12:00:00Z' });
    const after = resolvePrice(DEFAULT_PRICING, { provider: 'grok', model: 'grok-voice-latest', category: 'realtime_grok', at: '2026-08-05T00:00:00Z' });
    t.equal(before.unit_prices.per_audio_minute, 0.05, 'usage before the price change keeps the old price');
    t.equal(after.unit_prices.per_audio_minute, 0.08, 'usage from the effective date uses the new price');
    const tooEarly = resolvePrice(DEFAULT_PRICING, { provider: 'grok', model: 'grok-voice-latest', category: 'realtime_grok', at: '2025-12-31' });
    t.equal(tooEarly, null, 'no price before the first effective date');

    const rows = [...DEFAULT_PRICING, { ...DEFAULT_PRICING[0], id: 'g-new', effective_from: '2026-09-15', unit_prices: { ...DEFAULT_PRICING[0].unit_prices, audio_output_per_1m: 20 } }];
    t.equal(resolvePrice(rows, { provider: 'gemini', model: 'gemini-3.1-flash-live-preview', category: 'realtime_gemini', at: '2026-09-14' }).id, DEFAULT_PRICING[0].id, 'older version still applies before new effective date');
    t.equal(resolvePrice(rows, { provider: 'gemini', model: 'gemini-3.1-flash-live-preview', category: 'realtime_gemini', at: '2026-09-15' }).id, 'g-new', 'newest version with effective_from <= date wins');

    const grokCost = computeUsageCost({ billable_seconds: 90, input_text_tokens: 500 }, 'actual', after);
    t.close(grokCost.cost, 1.5 * 0.08, 'per-minute billing uses measured minutes');
    t.equal(grokCost.basis, 'estimated', 'per-minute billing from our clock is ESTIMATED');
}

function testConversion() {
    const usd = convert(10, 'USD', RATES);
    t.close(usd.eur, 5, 'USD→EUR via usd_to_eur');
    t.close(usd.mdl, 100, 'EUR→MDL via eur_to_mdl');
    const mdl = convert(40, 'MDL', RATES);
    t.close(mdl.eur, 2, 'MDL→EUR');
    t.close(convert(3, 'EUR', RATES).mdl, 60, 'EUR→MDL');
    t.deepEqual(convert(null, 'USD', RATES), { eur: null, mdl: null }, 'null stays null (unpriced)');
    const tiny = convert(0.0000123, 'USD', RATES);
    t.ok(tiny.mdl > 0 && tiny.mdl < 0.001, 'very small per-session amounts keep precision');
}

function testNormalization() {
    const g = normalizeGeminiUsage({
        promptTokenCount: 120, responseTokenCount: 300, totalTokenCount: 420,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }, { modality: 'AUDIO', tokenCount: 100 }],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 280 }, { modality: 'TEXT', tokenCount: 20 }],
    });
    t.equal(g.input_text_tokens, 20);
    t.equal(g.input_audio_tokens, 100);
    t.equal(g.output_audio_tokens, 280);
    t.equal(g.output_text_tokens, 20);
    t.equal(g.input_other_tokens, 0, 'fully itemized → no unknown modality');
    t.equal(g.total_tokens, 420);
    const partial = normalizeGeminiUsage({ promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 });
    t.equal(partial.input_other_tokens, 50, 'missing details → unknown-modality input');
    t.equal(partial.output_text_tokens, 5, 'thinking tokens billed as text output');
    t.equal(normalizeGeminiUsage(null), null, 'missing metadata → null');
    t.equal(normalizeGeminiUsage({}), null, 'empty metadata → null');
    const x = normalizeRealtimeCompatUsage({ input_tokens: 30, output_tokens: 70, total_tokens: 100, input_token_details: { audio_tokens: 25, text_tokens: 5 }, output_token_details: { audio_tokens: 60, text_tokens: 10 } });
    t.equal(x.input_audio_tokens, 25);
    t.equal(x.output_audio_tokens, 60);
    t.equal(x.total_tokens, 100);
}

function testMeterAndDuplicateFinalization() {
    let clock = Date.parse('2026-09-10T10:00:00Z');
    const meter = createSessionUsageMeter({ sessionId: 's1', provider: 'gemini', model: 'gemini-3.1-flash-live-preview', now: () => clock });
    meter.noteTurn();
    meter.noteInputAudioBytes(32000 * 4, 16000); // 4 s
    meter.noteOutputAudioChunk({ audio_base64: Buffer.alloc(48000 * 2).toString('base64'), sample_rate: 24000 }); // 2 s
    meter.onProviderUsage({ promptTokenCount: 100, responseTokenCount: 50, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 100 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 50 }] }, { kind: 'gemini_usage_metadata', providerInstanceId: 'p1' });
    // Provider rotation/reconnect: usage keeps accumulating in the same meter.
    meter.onProviderUsage({ promptTokenCount: 10, responseTokenCount: 5, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }], responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 5 }] }, { kind: 'gemini_usage_metadata', providerInstanceId: 'p2' });
    meter.onProviderUsage('garbage', {}); // never throws
    clock += 30000;
    const record = meter.finalize({ endReason: 'disconnect' });
    t.ok(record, 'first finalize returns a record');
    t.equal(record.record_id, 'rt:s1', 'record id is derived from session id (idempotency key)');
    t.equal(record.usage_basis, 'actual');
    t.equal(record.usage.input_audio_tokens, 110, 'usage summed across provider instances');
    t.equal(record.usage.output_audio_tokens, 55);
    t.equal(record.provider_connections, 2);
    t.close(record.usage.audio_input_seconds, 4, 'measured input audio seconds');
    t.close(record.usage.audio_output_seconds, 2, 'measured output audio seconds');
    t.equal(record.duration_ms, 30000);
    t.equal(record.usage_raw.provider_usage_events.length, 3, 'raw usage events persisted for recalculation');
    t.equal(meter.finalize({ endReason: 'socket_error' }), null, 'duplicate finalization yields nothing');

    const bare = createSessionUsageMeter({ sessionId: 's2', provider: 'gemini', model: 'gemini-3.1-flash-live-preview', now: () => clock });
    bare.noteTurn();
    bare.noteInputAudioBytes(32000 * 10, 16000);
    const bareRecord = bare.finalize({});
    t.equal(bareRecord.usage_basis, 'estimated', 'missing provider usage metadata → ESTIMATED');
    const price = resolvePrice(DEFAULT_PRICING, { provider: 'gemini', model: 'gemini-3.1-flash-live-preview', category: 'realtime_gemini', at: bareRecord.occurred_at });
    const est = computeUsageCost(bareRecord.usage, bareRecord.usage_basis, price);
    t.equal(est.method, 'audio_seconds_to_tokens', 'estimate falls back to measured audio seconds');
    t.close(est.cost, (10 * 25 * 3) / 1e6, 'estimate = seconds × tokens/s × audio input price');
}

async function testIdempotentPersistence() {
    const store = createMemoryCostStore();
    const meter = createSessionUsageMeter({ sessionId: 'dup', provider: 'gemini', model: 'gemini-3.1-flash-live-preview' });
    meter.noteTurn();
    const record = meter.finalize({});
    const first = await costTelemetry.recordRealtimeSession(record, { store });
    const second = await costTelemetry.recordRealtimeSession(record, { store });
    t.equal(first.inserted, true, 'first write inserts');
    t.equal(second.inserted, false, 'retry of the same session is ignored');
    const rows = await store.listUsageRecords({ from: '2000-01-01', to: '2100-01-01' });
    t.equal(rows.length, 1, 'no double counting');
    t.equal(rows[0].pricing_id, DEFAULT_PRICING[0].id, 'pricing version recorded at write time');
}

async function testDbFailureIsolation() {
    const failing = {
        backend: 'failing',
        init: () => Promise.reject(new Error('db down')),
        insertUsageRecord: () => Promise.reject(new Error('db down')),
        listPricing: () => Promise.reject(new Error('db down')),
    };
    const result = await costTelemetry.recordRealtimeSession({ record_id: 'rt:x', kind: 'realtime_session', occurred_at: new Date().toISOString(), category: 'realtime_gemini', provider: 'gemini', model: 'm', usage: {}, usage_basis: 'estimated' }, { store: failing });
    t.equal(result.ok, false, 'failed persistence resolves (never rejects)');
    const apiResult = await costTelemetry.recordApiCall({ category: 'llm_text', model: 'gemini-2.5-flash', usageMetadata: { promptTokenCount: 1 } }, { store: failing });
    t.equal(apiResult.ok, false, 'api call telemetry failure resolves');

    // End-to-end: a full realtime turn completes while the store is broken
    // or hanging, and session teardown does not throw.
    const { startTestServer } = require('./helpers/testServer');
    const { connect } = require('./helpers/wsTestClient');
    for (const store of [failing, { ...failing, insertUsageRecord: () => new Promise(() => {}), listPricing: () => new Promise(() => {}) }]) {
        setCostStoreForTests(store);
        const { port, close } = await startTestServer();
        try {
            const client = await connect(port);
            await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
            client.sendJson({ type: 'session.start', sampleRate: 16000 });
            await client.waitFor((e) => e.type === 'session.config.applied', { label: 'config' });
            client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
            await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input start' });
            client.sendBinary(Buffer.alloc(320));
            client.sendJson({ type: 'input_audio.end' });
            const end = await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end', timeoutMs: 6000 });
            t.ok(end.generation_id, 'realtime turn completes although cost persistence is failing');
            const failedBefore = costTelemetry.getTelemetryStats().failed;
            client.sendCloseFrame(); // finalization → persistence attempt against the broken store
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (store === failing) t.ok(costTelemetry.getTelemetryStats().failed > failedBefore, 'failed persistence observed and swallowed');
            client.close();
        } finally {
            await close();
        }
    }
    setCostStoreForTests(null);
}

async function testRealtimeSessionProducesRecord() {
    const store = createMemoryCostStore();
    setCostStoreForTests(store);
    const { startTestServer } = require('./helpers/testServer');
    const { connect } = require('./helpers/wsTestClient');
    const { port, close } = await startTestServer();
    try {
        const client = await connect(port);
        const ready = await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { label: 'config' });
        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input start' });
        client.sendBinary(Buffer.alloc(3200));
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end', timeoutMs: 6000 });
        client.sendCloseFrame();
        // A second close path (duplicate finalization) must not add a record.
        client.sendCloseFrame();
        let rows = [];
        for (let i = 0; i < 40 && rows.length === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            rows = await store.listUsageRecords({ from: '2000-01-01', to: '2100-01-01' });
        }
        t.equal(rows.length, 1, 'completed realtime session produces exactly one durable record');
        t.equal(rows[0].session_id, ready.session_id, 'record keyed by the realtime session id');
        t.equal(rows[0].turn_count, 1, 'turn counted');
        t.ok(rows[0].usage.audio_input_seconds > 0, 'input audio measured');
        t.ok(rows[0].usage.audio_output_seconds > 0, 'output audio measured');
        client.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
        t.equal((await store.listUsageRecords({ from: '2000-01-01', to: '2100-01-01' })).length, 1, 'still exactly one record after repeated close');
    } finally {
        await close();
        setCostStoreForTests(null);
    }
}

function testAggregation() {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const usage = { input_audio_tokens: 1_000_000, output_audio_tokens: 0 }; // $3 → €1.5 → 30 MDL
    const records = [
        sessionRecord('today', { at: '2026-09-28T08:00:00Z', usage }),
        sessionRecord('week', { at: '2026-09-23T08:00:00Z', usage }),
        sessionRecord('month', { at: '2026-09-02T08:00:00Z', usage }),
        sessionRecord('empty', { at: '2026-09-02T09:00:00Z', usage: {}, turns: 0 }),
        sessionRecord('lastMonth', { at: '2026-08-20T08:00:00Z', usage }),
        sessionRecord('unpriced', { at: '2026-09-27T08:00:00Z', model: 'unknown-model', usage }),
    ];
    const fixed = [
        { id: 'f1', name: 'Railway', category: 'infrastructure', amount: 10, currency: 'EUR', active: true },
        { id: 'f2', name: 'Old', category: 'infrastructure', amount: 99, currency: 'EUR', active: true, effective_to: '2026-09-01' },
        { id: 'f3', name: 'Off', category: 'infrastructure', amount: 99, currency: 'EUR', active: false },
    ];
    const s = buildSummary({ records, pricingRows: DEFAULT_PRICING, fixedItems: fixed, settings: SETTINGS, now });
    t.close(s.periods.today.cost_mdl, 30, 'today total MDL');
    t.equal(s.periods.today.conversations, 1);
    t.close(s.periods.last_7_days.cost_mdl, 60, '7-day total excludes older + unpriced');
    t.equal(s.periods.last_7_days.unpriced_records, 1, 'unpriced counted, not costed');
    t.close(s.periods.month.api_cost_mdl, 90, 'month API cost excludes previous month');
    t.equal(s.periods.month.conversations, 4, 'conversations = sessions with ≥1 turn');
    t.equal(s.periods.month.realtime_sessions, 5);
    t.close(s.periods.month.avg_cost_per_conversation_mdl, 90 / 4, 'average cost per conversation');
    t.close(s.fixed_costs.mdl, 200, 'only fixed items active in this month (MANUAL)');
    t.equal(s.fixed_costs.items.length, 1);
    t.close(s.periods.month.total_cost_mdl, 290, 'month total = API + fixed');
    const fraction = s.periods.month.elapsed_fraction;
    t.ok(fraction > 0.9 && fraction < 1, 'month elapsed fraction in Europe/Chisinau');
    t.close(s.periods.month.projected_total_cost_mdl, 90 / periodBounds(now, 'Europe/Chisinau').monthElapsedFraction + 200, 'projection extrapolates API, adds full fixed', 1e-4);
    t.close(s.budget.percent_used, 29, 'budget percent used');
    t.equal(s.budget.level, 'ok');
    t.equal(s.budget.enforcement, 'observability_only');
    t.equal(s.recent_sessions.length, 6, 'recent sessions list every loaded realtime session');
    t.equal(s.recent_sessions[0].session_id, 'today', 'recent sessions newest first');
    t.ok(!('usage_raw' in s.recent_sessions[0]), 'session view never exposes raw provider payloads');
    const cat = s.breakdown.by_category.find((row) => row.category === 'realtime_gemini');
    t.equal(cat.records, 5, 'category breakdown for the month');
    t.equal(s.customer_summary, undefined, 'customer summary built by the API layer');

    // Month boundary follows Chisinau time, not UTC: 2026-08-31T22:30Z is
    // already September 1st in Chisinau (UTC+3).
    const boundary = buildSummary({ records: [sessionRecord('edge', { at: '2026-08-31T22:30:00Z', usage })], pricingRows: DEFAULT_PRICING, fixedItems: [], settings: SETTINGS, now });
    t.equal(boundary.periods.month.conversations, 1, 'calendar month uses the customer time zone');
}

function testBudgetAndFixed() {
    const warn = budgetStatus({ budgetMdl: 100, usedMdl: 75, projectedMdl: 120, thresholds: [70, 90, 100] });
    t.equal(warn.level, 'warning');
    t.equal(warn.crossed_threshold, 70);
    t.equal(warn.projected_over_budget, true);
    t.equal(budgetStatus({ budgetMdl: 100, usedMdl: 95, projectedMdl: 95, thresholds: [70, 90, 100] }).level, 'critical');
    const over = budgetStatus({ budgetMdl: 100, usedMdl: 130, projectedMdl: 140, thresholds: [70, 90, 100] });
    t.equal(over.level, 'exceeded');
    t.close(over.percent_used, 130, 'percent can exceed 100 (no enforcement)');
    t.equal(budgetStatus({ budgetMdl: null, usedMdl: 10, projectedMdl: 20 }).level, 'not_configured');

    const fixed = fixedCostsForMonth([
        { id: 'a', name: 'Railway', amount: 5, currency: 'USD', active: true },
        { id: 'b', name: 'PG', amount: 100, currency: 'MDL', active: true, effective_from: '2026-09-15' },
        { id: 'c', name: 'Future', amount: 100, currency: 'MDL', active: true, effective_from: '2026-10-01' },
    ], '2026-09-01', '2026-10-01', RATES);
    t.close(fixed.mdl, 5 * 0.5 * 20 + 100, 'fixed costs converted from USD and MDL; future items excluded');
    t.equal(fixed.basis, 'manual');
    t.ok(fixed.items.every((i) => i.basis === 'manual'), 'fixed items labelled MANUAL');

    const { errors } = sanitizeSettingsPatch({ eur_to_mdl: -1, warning_thresholds: 'x', timezone: 'Mars/Base' });
    t.ok(errors.includes('eur_to_mdl_invalid') && errors.includes('warning_thresholds_invalid') && errors.includes('timezone_invalid'), 'invalid settings rejected');
}

function fakeRes() {
    return { status: null, body: null };
}

async function testApiShape() {
    const store = createMemoryCostStore();
    const now = Date.parse('2026-09-28T12:00:00Z');
    await store.insertUsageRecord({ ...sessionRecord('api1', { at: '2026-09-28T08:00:00Z', usage: { input_audio_tokens: 1000, output_audio_tokens: 2000 } }), usage_raw: { provider_usage_events: [{ usage: { secret: 'x' } }] } });
    const responses = [];
    const sendJson = (res, status, body) => { res.status = status; res.body = JSON.parse(JSON.stringify(body)); responses.push(res); };
    const bodies = [];
    const readJsonBody = async () => bodies.shift() || {};
    const api = createCostApi({ sendJson, readJsonBody, getStore: () => store, nowFn: () => now });
    const call = async (method, path, body) => {
        const url = new URL(path, 'http://x');
        if (body) bodies.push(body);
        const res = fakeRes();
        const handled = await api.handle({ method, headers: {} }, res, url.pathname, url.searchParams);
        t.ok(handled, `${method} ${path} handled`);
        return res;
    };

    await call('PUT', '/api/cost/settings', { monthly_budget_mdl: 500, eur_to_mdl: 20, usd_to_eur: 0.5 });
    const fixedRes = await call('POST', '/api/cost/fixed-costs', { name: 'Railway', amount: 10, currency: 'EUR' });
    t.equal(fixedRes.status, 200);
    const badFixed = await call('POST', '/api/cost/fixed-costs', { name: '', amount: -1 });
    t.equal(badFixed.status, 400, 'invalid fixed cost rejected');

    const summary = await call('GET', '/api/cost/summary');
    t.equal(summary.status, 200);
    const b = summary.body;
    for (const key of ['today', 'last_7_days', 'month']) {
        for (const field of ['cost_mdl', 'cost_eur', 'conversations', 'conversation_duration_ms', 'basis']) {
            t.ok(field in b.periods[key], `summary.periods.${key}.${field}`);
        }
    }
    for (const field of ['api_cost_mdl', 'fixed_cost_mdl', 'total_cost_mdl', 'total_cost_eur', 'projected_total_cost_mdl', 'avg_cost_per_conversation_mdl']) {
        t.ok(field in b.periods.month, `summary.periods.month.${field}`);
    }
    t.equal(b.budget.configured, true);
    t.ok(Array.isArray(b.breakdown.by_provider_model) && Array.isArray(b.breakdown.by_category), 'breakdowns present');
    t.equal(b.currency_primary, 'MDL');
    t.equal(b.customer_summary.conversations, 1);
    t.close(b.customer_summary.infrastructure_cost_mdl, 200, 'customer summary includes MANUAL infra cost');
    t.ok(!JSON.stringify(b).includes('secret'), 'raw provider payloads never returned by the API');
    t.ok(!/api[_-]?key/i.test(JSON.stringify(b)), 'no API key fields in the response');

    const ranged = await call('GET', '/api/cost/summary?from=2026-09-01&to=2026-09-28');
    t.ok(ranged.body.periods.range && ranged.body.periods.range.conversations === 1, 'date range supported');
    const badRange = await call('GET', '/api/cost/summary?from=2026-09-20&to=2026-09-01');
    t.equal(badRange.status, 400, 'inverted range rejected');

    const sessions = await call('GET', '/api/cost/sessions?from=2026-09-01&to=2026-09-30');
    t.equal(sessions.body.sessions.length, 1);
    for (const field of ['started_at', 'duration_ms', 'provider', 'model', 'usage', 'cost_mdl', 'cost_eur', 'cost_basis', 'status']) {
        t.ok(field in sessions.body.sessions[0], `session.${field}`);
    }
    const breakdownRes = await call('GET', '/api/cost/breakdown');
    t.ok(breakdownRes.body.by_category.length === 1 && breakdownRes.body.category_labels.realtime_gemini, 'breakdown endpoint');

    const pricingRes = await call('GET', '/api/cost/pricing');
    t.equal(pricingRes.body.pricing.length, DEFAULT_PRICING.length);
    const newPrice = await call('POST', '/api/cost/pricing', { provider: 'gemini', model: 'gemini-3.1-flash-live-preview', category: 'realtime_gemini', billing_unit: 'tokens', currency: 'USD', unit_prices: { audio_input_per_1m: 6 }, effective_from: '2026-09-28' });
    t.equal(newPrice.status, 200, 'new pricing version accepted');
    const badPrice = await call('POST', '/api/cost/pricing', { provider: 'gemini', model: 'm', category: 'llm_text', billing_unit: 'tokens', unit_prices: { a: -1 }, effective_from: 'bad' });
    t.equal(badPrice.status, 400);
    const repriced = await call('GET', '/api/cost/summary');
    t.close(repriced.body.periods.today.cost_eur, (1000 * 6) / 1e6 * 0.5, 'history re-priced from raw usage with the new effective version');

    const settingsRes = await call('GET', '/api/cost/settings');
    t.equal(settingsRes.body.settings.monthly_budget_mdl, 500);
    const customer = await call('GET', '/api/cost/customer-summary');
    t.equal(customer.body.customer_summary.title, 'WINE AI usage this month');

    process.env.ADMIN_TOKEN = 'tok';
    try {
        const denied = await call('PUT', '/api/cost/settings', { monthly_budget_mdl: 1 });
        t.equal(denied.status, 401, 'writes require admin token when configured');
        const res = fakeRes();
        bodies.push({ monthly_budget_mdl: 1 });
        await api.handle({ method: 'PUT', headers: { 'x-admin-token': 'tok' } }, res, '/api/cost/settings', new URLSearchParams());
        t.equal(res.status, 200, 'write with token accepted');
        const readAllowed = await call('GET', '/api/cost/summary');
        t.equal(readAllowed.status, 200, 'reads stay available');
    } finally {
        delete process.env.ADMIN_TOKEN;
    }

    const brokenApi = createCostApi({ sendJson, readJsonBody, getStore: () => ({ getSettings: () => Promise.reject(new Error('db')), listPricing: () => Promise.reject(new Error('db')), listFixedItems: () => Promise.reject(new Error('db')) }) });
    const res = fakeRes();
    await brokenApi.handle({ method: 'GET', headers: {} }, res, '/api/cost/summary', new URLSearchParams());
    t.equal(res.status, 503, 'storage failure → 503, not a crash');
}

async function run() {
    testCostCalculation();
    testPricingEffectiveDates();
    testConversion();
    testNormalization();
    testMeterAndDuplicateFinalization();
    await testIdempotentPersistence();
    testAggregation();
    testBudgetAndFixed();
    await testApiShape();
    await testRealtimeSessionProducesRecord();
    await testDbFailureIsolation();
    return { assertionCount: assertions };
}

module.exports = { run };

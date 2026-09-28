'use strict';

// Cost & Usage Control against a REAL PostgreSQL (TEST_DATABASE_URL or
// DATABASE_URL). Skips on the in-memory sentinel used by scripts/run-tests.js.
// Verifies: idempotent schema (applied twice), duplicate-finalization
// idempotency (ON CONFLICT DO NOTHING), numeric precision for tiny costs,
// pricing versions with effective dates, fixed costs CRUD, settings
// persistence and the summary API end-to-end on real rows.

const assert = require('assert');
const crypto = require('crypto');

async function run() {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url || url === 'memory') {
        console.log('skip: costStore.postgres.integration needs TEST_DATABASE_URL');
        return { assertionCount: 0 };
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const { applySchema, createPostgresCostStore } = require('../src/cost/costStore');
    const { recordRealtimeSession } = require('../src/cost/costTelemetry');
    const { createCostApi } = require('../src/cost/costApi');
    let n = 0;
    const ok = (v, m) => { n += 1; assert.ok(v, m); };
    const eq = (a, b, m) => { n += 1; assert.strictEqual(a, b, m); };
    const tag = crypto.randomBytes(4).toString('hex');

    try {
        await applySchema(pool);
        await applySchema(pool); // idempotent re-run (restart / redeploy)
        const store = createPostgresCostStore(() => pool);
        await store.init();

        const pricing = await store.listPricing();
        ok(pricing.some((p) => p.id === 'grok-voice-latest@2026-08-05' && p.effective_from === '2026-08-05'), 'seed pricing present with DATE effective_from');
        const seedCount = pricing.length;
        await applySchema(pool);
        eq((await store.listPricing()).length, seedCount, 'seeding is idempotent');

        const now = new Date();
        const record = {
            record_id: `rt:pgtest_${tag}`, kind: 'realtime_session', session_id: `pgtest_${tag}`,
            occurred_at: now.toISOString(), ended_at: now.toISOString(), duration_ms: 42000,
            category: 'realtime_gemini', provider: 'gemini', model: 'gemini-3.1-flash-live-preview',
            status: 'completed', end_reason: 'disconnect', turn_count: 2, provider_connections: 1,
            usage: { input_audio_tokens: 7, output_audio_tokens: 3 }, usage_basis: 'actual',
            usage_raw: { provider_usage_events: [{ usage: { promptTokenCount: 7 } }] },
        };
        const first = await recordRealtimeSession(record, { store });
        const second = await recordRealtimeSession(record, { store });
        eq(first.inserted, true, 'first insert');
        eq(second.inserted, false, 'duplicate finalization ignored by the database');
        const { rows } = await pool.query('SELECT count(*)::int AS c, max(cost_at_write)::text AS cost FROM ai_usage_records WHERE record_id = $1', [record.record_id]);
        eq(rows[0].c, 1, 'exactly one row');
        // 7 × $3/1M + 3 × $12/1M = $0.000057 — must survive NUMERIC storage.
        eq(Number(rows[0].cost), 0.000057, 'tiny per-session cost stored without precision loss');

        const listed = await store.listUsageRecords({ from: new Date(now.getTime() - 60000).toISOString(), to: new Date(now.getTime() + 60000).toISOString() });
        const mine = listed.find((r) => r.record_id === record.record_id);
        ok(mine && mine.usage.input_audio_tokens === 7 && mine.usage_raw.provider_usage_events.length === 1, 'raw + normalized usage round-trip');

        await store.upsertPricing({ id: `test-${tag}`, provider: 'gemini', model: `m-${tag}`, category: 'llm_text', billing_unit: 'tokens', currency: 'USD', unit_prices: { text_input_per_1m: 1 }, effective_from: '2026-09-01', effective_to: null, source_note: 'test' });
        ok((await store.listPricing()).some((p) => p.id === `test-${tag}`), 'pricing version upsert');

        const fixedId = `fx_${tag}`;
        await store.upsertFixedItem({ id: fixedId, name: 'Railway test', category: 'infrastructure', amount: 12.34, currency: 'EUR', active: true, effective_from: null, effective_to: null, note: '' });
        ok((await store.listFixedItems()).some((f) => f.id === fixedId && f.amount === 12.34), 'fixed cost stored');

        const before = await store.getSettings();
        await store.updateSettings({ monthly_budget_mdl: 777, warning_thresholds: [50, 80, 100] });
        const after = await store.getSettings();
        eq(after.monthly_budget_mdl, 777, 'budget persisted');
        eq(after.warning_thresholds.join(','), '50,80,100', 'thresholds persisted as JSON');

        const responses = [];
        const api = createCostApi({ sendJson: (res, status, body) => responses.push({ status, body }), readJsonBody: async () => ({}), getStore: () => store });
        await api.handle({ method: 'GET', headers: {} }, {}, '/api/cost/summary', new URLSearchParams());
        eq(responses[0].status, 200, 'summary on real Postgres rows');
        ok(responses[0].body.recent_sessions.some((s) => s.session_id === record.session_id), 'session visible in summary');

        // Clean up test rows; restore settings.
        await pool.query('DELETE FROM ai_usage_records WHERE record_id = $1', [record.record_id]);
        await pool.query('DELETE FROM ai_pricing WHERE id = $1', [`test-${tag}`]);
        await store.deleteFixedItem(fixedId);
        await store.updateSettings({ monthly_budget_mdl: before.monthly_budget_mdl, warning_thresholds: before.warning_thresholds });
    } finally {
        await pool.end();
    }
    return { assertionCount: n };
}

module.exports = { run };

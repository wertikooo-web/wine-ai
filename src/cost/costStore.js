'use strict';

// Persistence for Cost & Usage Control. Two interchangeable backends with
// the same async interface:
//   - Postgres (production): idempotent schema below, created lazily on
//     first use; raw usage is persisted so prices can be recalculated.
//   - in-memory (no DATABASE_URL, tests): same semantics, process-local.
//
// Idempotency: ai_usage_records.record_id is the primary key and inserts use
// ON CONFLICT DO NOTHING, so a duplicate finalization/retry of the same
// realtime session can never be counted twice.

const crypto = require('crypto');
const db = require('../knowledge/db');
const { DEFAULT_PRICING } = require('./pricing');

const DEFAULT_SETTINGS = Object.freeze({
    monthly_budget_mdl: null,
    // Configuration, not provider prices: MDL per EUR and EUR per USD.
    // Defaults are approximate and must be confirmed in the Dashboard.
    eur_to_mdl: Number(process.env.COST_EUR_TO_MDL) > 0 ? Number(process.env.COST_EUR_TO_MDL) : 19.5,
    usd_to_eur: Number(process.env.COST_USD_TO_EUR) > 0 ? Number(process.env.COST_USD_TO_EUR) : 0.86,
    rates_confirmed: false,
    warning_thresholds: [70, 90, 100],
    timezone: process.env.COST_TIMEZONE || 'Europe/Chisinau',
    // Knowledge source switch (Dashboard → Settings): false = answer only
    // from our own knowledge base, never search the internet. Lives here
    // because it is the main per-call cost lever and needs the same
    // persistence + admin gate; read at runtime via webSearchSetting.js.
    web_search_enabled: true,
});

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

function sanitizeSettingsPatch(patch = {}) {
    const out = {};
    const errors = [];
    if ('monthly_budget_mdl' in patch) {
        const v = patch.monthly_budget_mdl;
        if (v === null || v === '') out.monthly_budget_mdl = null;
        else if (Number.isFinite(Number(v)) && Number(v) >= 0) out.monthly_budget_mdl = Number(v);
        else errors.push('monthly_budget_mdl_invalid');
    }
    for (const key of ['eur_to_mdl', 'usd_to_eur']) {
        if (key in patch) {
            if (Number.isFinite(Number(patch[key])) && Number(patch[key]) > 0) out[key] = Number(patch[key]);
            else errors.push(`${key}_invalid`);
        }
    }
    if ('rates_confirmed' in patch) out.rates_confirmed = patch.rates_confirmed === true;
    if ('web_search_enabled' in patch) {
        if (typeof patch.web_search_enabled === 'boolean') out.web_search_enabled = patch.web_search_enabled;
        else errors.push('web_search_enabled_invalid');
    }
    if ('warning_thresholds' in patch) {
        const list = Array.isArray(patch.warning_thresholds) ? patch.warning_thresholds.map(Number) : [];
        if (list.length && list.every((x) => Number.isFinite(x) && x > 0 && x <= 1000)) {
            out.warning_thresholds = [...new Set(list)].sort((a, b) => a - b);
        } else errors.push('warning_thresholds_invalid');
    }
    if ('timezone' in patch) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: String(patch.timezone) });
            out.timezone = String(patch.timezone);
        } catch {
            errors.push('timezone_invalid');
        }
    }
    return { patch: out, errors };
}

function sanitizeFixedItem(item = {}) {
    const errors = [];
    const name = String(item.name || '').trim().slice(0, 120);
    if (!name) errors.push('name_required');
    const amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount < 0) errors.push('amount_invalid');
    const currency = String(item.currency || 'EUR').toUpperCase();
    if (!['EUR', 'USD', 'MDL'].includes(currency)) errors.push('currency_invalid');
    const effectiveFrom = item.effective_from ? String(item.effective_from).slice(0, 10) : null;
    const effectiveTo = item.effective_to ? String(item.effective_to).slice(0, 10) : null;
    for (const [key, value] of [['effective_from', effectiveFrom], ['effective_to', effectiveTo]]) {
        if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push(`${key}_invalid`);
    }
    return {
        errors,
        item: {
            id: item.id ? String(item.id).slice(0, 64) : `fx_${crypto.randomBytes(6).toString('hex')}`,
            name,
            category: String(item.category || 'infrastructure').slice(0, 40),
            amount,
            currency,
            active: item.active !== false,
            effective_from: effectiveFrom,
            effective_to: effectiveTo,
            note: String(item.note || '').slice(0, 300),
        },
    };
}

// ---------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------

async function applySchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_usage_records (
            record_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            session_id TEXT,
            occurred_at TIMESTAMPTZ NOT NULL,
            ended_at TIMESTAMPTZ,
            duration_ms BIGINT,
            category TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT,
            operation TEXT,
            voice_mode TEXT,
            status TEXT,
            end_reason TEXT,
            turn_count INT NOT NULL DEFAULT 0,
            provider_connections INT NOT NULL DEFAULT 0,
            usage JSONB NOT NULL,
            usage_basis TEXT NOT NULL CHECK (usage_basis IN ('actual', 'estimated')),
            usage_raw JSONB,
            pricing_id TEXT,
            cost_at_write NUMERIC(24,12),
            cost_currency_at_write TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_records_occurred ON ai_usage_records(occurred_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_records_category ON ai_usage_records(category, occurred_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_records_session ON ai_usage_records(session_id);');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_pricing (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            category TEXT NOT NULL,
            billing_unit TEXT NOT NULL CHECK (billing_unit IN ('tokens', 'audio_minute', 'request')),
            currency TEXT NOT NULL DEFAULT 'USD',
            unit_prices JSONB NOT NULL,
            effective_from DATE NOT NULL,
            effective_to DATE,
            source_note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_pricing_lookup ON ai_pricing(provider, model, category, effective_from);');
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cost_fixed_items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'infrastructure',
            amount NUMERIC(14,4) NOT NULL CHECK (amount >= 0),
            currency TEXT NOT NULL DEFAULT 'EUR',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            effective_from DATE,
            effective_to DATE,
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cost_settings (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    for (const row of DEFAULT_PRICING) {
        await pool.query(
            `INSERT INTO ai_pricing (id, provider, model, category, billing_unit, currency, unit_prices, effective_from, effective_to, source_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
            [row.id, row.provider, row.model, row.category, row.billing_unit, row.currency, JSON.stringify(row.unit_prices), row.effective_from, row.effective_to, row.source_note],
        );
    }
}

function dateOnly(value) {
    if (!value) return null;
    if (value instanceof Date) {
        // DATE columns come back as local-midnight Date objects from pg.
        const y = value.getFullYear();
        const m = String(value.getMonth() + 1).padStart(2, '0');
        const d = String(value.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
}

function iso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapUsageRow(r) {
    return {
        record_id: r.record_id,
        kind: r.kind,
        session_id: r.session_id,
        occurred_at: iso(r.occurred_at),
        ended_at: iso(r.ended_at),
        duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
        category: r.category,
        provider: r.provider,
        model: r.model,
        operation: r.operation,
        voice_mode: r.voice_mode,
        status: r.status,
        end_reason: r.end_reason,
        turn_count: Number(r.turn_count || 0),
        provider_connections: Number(r.provider_connections || 0),
        usage: r.usage || {},
        usage_basis: r.usage_basis,
        usage_raw: r.usage_raw,
        pricing_id: r.pricing_id,
        cost_at_write: r.cost_at_write === null ? null : Number(r.cost_at_write),
        cost_currency_at_write: r.cost_currency_at_write,
    };
}

function mapPricingRow(r) {
    return {
        id: r.id,
        provider: r.provider,
        model: r.model,
        category: r.category,
        billing_unit: r.billing_unit,
        currency: r.currency,
        unit_prices: r.unit_prices || {},
        effective_from: dateOnly(r.effective_from),
        effective_to: dateOnly(r.effective_to),
        source_note: r.source_note,
    };
}

function mapFixedRow(r) {
    return {
        id: r.id,
        name: r.name,
        category: r.category,
        amount: Number(r.amount),
        currency: r.currency,
        active: r.active,
        effective_from: dateOnly(r.effective_from),
        effective_to: dateOnly(r.effective_to),
        note: r.note,
    };
}

function createPostgresCostStore(poolProvider = () => db.getPool()) {
    let ready = null;
    function pool() {
        const p = poolProvider();
        if (!p) throw Object.assign(new Error('cost_store_unavailable'), { code: 'cost_store_unavailable' });
        return p;
    }
    function init() {
        if (!ready) {
            ready = applySchema(pool()).catch((error) => {
                ready = null; // allow a later retry
                throw error;
            });
        }
        return ready;
    }
    return {
        backend: 'postgres',
        init,
        async insertUsageRecord(rec) {
            await init();
            const result = await pool().query(
                `INSERT INTO ai_usage_records (record_id, kind, session_id, occurred_at, ended_at, duration_ms, category, provider, model, operation, voice_mode, status, end_reason, turn_count, provider_connections, usage, usage_basis, usage_raw, pricing_id, cost_at_write, cost_currency_at_write)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
                 ON CONFLICT (record_id) DO NOTHING`,
                [rec.record_id, rec.kind, rec.session_id || null, rec.occurred_at, rec.ended_at || null, rec.duration_ms ?? null,
                    rec.category, rec.provider, rec.model || null, rec.operation || null, rec.voice_mode || null, rec.status || null,
                    rec.end_reason || null, rec.turn_count || 0, rec.provider_connections || 0, JSON.stringify(rec.usage || {}),
                    rec.usage_basis, JSON.stringify(rec.usage_raw || null), rec.pricing_id || null,
                    rec.cost_at_write ?? null, rec.cost_currency_at_write || null],
            );
            return { inserted: result.rowCount === 1 };
        },
        async listUsageRecords({ from, to, limit = 20000 } = {}) {
            await init();
            const { rows } = await pool().query(
                `SELECT * FROM ai_usage_records WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at DESC LIMIT $3`,
                [from, to, limit],
            );
            return rows.map(mapUsageRow);
        },
        async listPricing() {
            await init();
            const { rows } = await pool().query('SELECT * FROM ai_pricing ORDER BY provider, model, category, effective_from');
            return rows.map(mapPricingRow);
        },
        async upsertPricing(row) {
            await init();
            await pool().query(
                `INSERT INTO ai_pricing (id, provider, model, category, billing_unit, currency, unit_prices, effective_from, effective_to, source_note)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (id) DO UPDATE SET provider=EXCLUDED.provider, model=EXCLUDED.model, category=EXCLUDED.category,
                   billing_unit=EXCLUDED.billing_unit, currency=EXCLUDED.currency, unit_prices=EXCLUDED.unit_prices,
                   effective_from=EXCLUDED.effective_from, effective_to=EXCLUDED.effective_to, source_note=EXCLUDED.source_note, updated_at=NOW()`,
                [row.id, row.provider, row.model, row.category, row.billing_unit, row.currency || 'USD', JSON.stringify(row.unit_prices), row.effective_from, row.effective_to || null, row.source_note || null],
            );
            return row;
        },
        async listFixedItems() {
            await init();
            const { rows } = await pool().query('SELECT * FROM cost_fixed_items ORDER BY created_at');
            return rows.map(mapFixedRow);
        },
        async upsertFixedItem(item) {
            await init();
            await pool().query(
                `INSERT INTO cost_fixed_items (id, name, category, amount, currency, active, effective_from, effective_to, note)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, amount=EXCLUDED.amount,
                   currency=EXCLUDED.currency, active=EXCLUDED.active, effective_from=EXCLUDED.effective_from,
                   effective_to=EXCLUDED.effective_to, note=EXCLUDED.note, updated_at=NOW()`,
                [item.id, item.name, item.category, item.amount, item.currency, item.active, item.effective_from, item.effective_to, item.note],
            );
            return item;
        },
        async deleteFixedItem(id) {
            await init();
            const result = await pool().query('DELETE FROM cost_fixed_items WHERE id = $1', [id]);
            return { deleted: result.rowCount === 1 };
        },
        async getSettings() {
            await init();
            const { rows } = await pool().query('SELECT key, value FROM cost_settings');
            const settings = { ...DEFAULT_SETTINGS };
            for (const row of rows) if (SETTINGS_KEYS.includes(row.key)) settings[row.key] = row.value;
            return settings;
        },
        async updateSettings(patch) {
            await init();
            for (const [key, value] of Object.entries(patch)) {
                await pool().query(
                    `INSERT INTO cost_settings (key, value) VALUES ($1, $2)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                    [key, JSON.stringify(value)],
                );
            }
            return this.getSettings();
        },
    };
}

// ---------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------

function createMemoryCostStore({ pricing = DEFAULT_PRICING } = {}) {
    const records = new Map();
    const pricingRows = new Map(pricing.map((row) => [row.id, JSON.parse(JSON.stringify(row))]));
    const fixed = new Map();
    let settings = { ...DEFAULT_SETTINGS };
    return {
        backend: 'memory',
        async init() {},
        async insertUsageRecord(rec) {
            if (records.has(rec.record_id)) return { inserted: false };
            records.set(rec.record_id, JSON.parse(JSON.stringify(rec)));
            return { inserted: true };
        },
        async listUsageRecords({ from, to, limit = 20000 } = {}) {
            const fromMs = new Date(from).getTime();
            const toMs = new Date(to).getTime();
            return [...records.values()]
                .filter((r) => { const t = new Date(r.occurred_at).getTime(); return t >= fromMs && t < toMs; })
                .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
                .slice(0, limit);
        },
        async listPricing() { return [...pricingRows.values()]; },
        async upsertPricing(row) { pricingRows.set(row.id, JSON.parse(JSON.stringify(row))); return row; },
        async listFixedItems() { return [...fixed.values()]; },
        async upsertFixedItem(item) { fixed.set(item.id, { ...item }); return item; },
        async deleteFixedItem(id) { return { deleted: fixed.delete(id) }; },
        async getSettings() { return { ...settings }; },
        async updateSettings(patch) { settings = { ...settings, ...patch }; return { ...settings }; },
    };
}

// tests/run-tests.js sets DATABASE_URL=memory as a sentinel for "no real
// Postgres"; treat it like an absent database.
function isPostgresConfigured() {
    return db.isEnabled() && process.env.DATABASE_URL !== 'memory';
}

let defaultStore = null;
function getCostStore() {
    if (!defaultStore) defaultStore = isPostgresConfigured() ? createPostgresCostStore() : createMemoryCostStore();
    return defaultStore;
}

function setCostStoreForTests(store) {
    defaultStore = store;
}

module.exports = {
    DEFAULT_SETTINGS,
    sanitizeSettingsPatch,
    sanitizeFixedItem,
    applySchema,
    createPostgresCostStore,
    createMemoryCostStore,
    getCostStore,
    setCostStoreForTests,
    isPostgresConfigured,
};

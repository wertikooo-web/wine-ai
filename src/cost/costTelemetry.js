'use strict';

// Fire-and-forget facade used by runtime code (realtime sessions and other
// metered AI calls). Contract: these functions NEVER throw and NEVER make a
// caller wait — they return a promise that always resolves, so a Postgres
// outage or a bug in cost accounting cannot crash or block a conversation.

const crypto = require('crypto');
const { getCostStore } = require('./costStore');
const { DEFAULT_PRICING, resolvePrice, computeUsageCost } = require('./pricing');
const { emptyUsage, normalizeGeminiUsage } = require('./usageNormalize');

const PRICING_CACHE_MS = 60 * 1000;
const MAX_IN_FLIGHT = 200;

let pricingCache = { rows: null, at: 0 };
let inFlight = 0;
const stats = { recorded: 0, duplicates: 0, failed: 0, dropped: 0, lastError: null };

function logFailure(stage, error) {
    stats.failed += 1;
    stats.lastError = String(error?.message || error).slice(0, 200);
    console.warn(`[CostTelemetry] ${stage}_failed message=${stats.lastError}`);
}

async function pricingRows(store) {
    if (pricingCache.rows && Date.now() - pricingCache.at < PRICING_CACHE_MS) return pricingCache.rows;
    try {
        const rows = await store.listPricing();
        pricingCache = { rows, at: Date.now() };
        return rows;
    } catch {
        return pricingCache.rows || DEFAULT_PRICING;
    }
}

function invalidatePricingCache() {
    pricingCache = { rows: null, at: 0 };
}

async function persist(record, { store = getCostStore() } = {}) {
    const rows = await pricingRows(store);
    const price = resolvePrice(rows, { provider: record.provider, model: record.model, category: record.category, at: record.occurred_at });
    const cost = computeUsageCost(record.usage, record.usage_basis, price);
    const result = await store.insertUsageRecord({
        ...record,
        pricing_id: price?.id || null,
        cost_at_write: cost.cost,
        cost_currency_at_write: cost.currency,
    });
    if (result.inserted) stats.recorded += 1;
    else stats.duplicates += 1;
    return result;
}

function record(recordValue, options = {}) {
    try {
        if (!recordValue || !recordValue.record_id) return Promise.resolve({ ok: false, reason: 'no_record' });
        if (inFlight >= MAX_IN_FLIGHT) {
            stats.dropped += 1;
            return Promise.resolve({ ok: false, reason: 'backpressure' });
        }
        inFlight += 1;
        return persist(recordValue, options)
            .then((result) => ({ ok: true, inserted: result.inserted }))
            .catch((error) => {
                logFailure('persist', error);
                return { ok: false, reason: 'persist_failed' };
            })
            .finally(() => { inFlight -= 1; });
    } catch (error) {
        logFailure('record', error);
        return Promise.resolve({ ok: false, reason: 'record_failed' });
    }
}

// Realtime session record produced by sessionUsageMeter.finalize().
function recordRealtimeSession(sessionRecord, options) {
    return record(sessionRecord, options);
}

// Non-realtime metered AI call. Pass the provider's raw usage metadata when
// the SDK returned one (usage_basis=actual); otherwise pass measured
// quantities (inputChars/requests) and the record is marked estimated.
function recordApiCall({
    category, provider = 'gemini', model, operation, sessionId = null,
    usageMetadata = null, requests = 0, inputChars = 0, extraRaw = null, basis = null,
} = {}, options) {
    try {
        const normalized = usageMetadata ? normalizeGeminiUsage(usageMetadata) : null;
        const usage = normalized || emptyUsage();
        usage.requests = Number(requests) > 0 ? Number(requests) : 0;
        if (!normalized && Number(inputChars) > 0) usage.input_chars = Number(inputChars);
        // 'actual' only when the provider itself reported the usage, or the
        // caller asserts an exact count (e.g. one grounded request).
        const usageBasis = basis === 'actual' || basis === 'estimated' ? basis : (normalized ? 'actual' : 'estimated');
        const now = new Date().toISOString();
        return record({
            record_id: `api:${crypto.randomUUID()}`,
            kind: 'api_call',
            session_id: sessionId,
            occurred_at: now,
            ended_at: now,
            duration_ms: null,
            category,
            provider,
            model: model || null,
            operation: operation || null,
            status: 'completed',
            turn_count: 0,
            provider_connections: 0,
            usage,
            usage_basis: usageBasis,
            usage_raw: { usage_metadata: usageMetadata || null, measured: { requests, input_chars: inputChars }, extra: extraRaw },
        }, options);
    } catch (error) {
        logFailure('record_api_call', error);
        return Promise.resolve({ ok: false, reason: 'record_failed' });
    }
}

function getTelemetryStats() {
    return { ...stats, inFlight };
}

module.exports = {
    recordRealtimeSession,
    recordApiCall,
    invalidatePricingCache,
    getTelemetryStats,
};

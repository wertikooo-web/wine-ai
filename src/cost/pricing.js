'use strict';

// Pricing table + cost calculation for WINE AI Cost & Usage Control.
//
// Every provider price lives in ONE versioned table (seeded from
// DEFAULT_PRICING below, stored/edited in Postgres table ai_pricing). No
// other file multiplies usage by a price. A price row applies to usage that
// occurred on/after effective_from and before effective_to (exclusive), so
// historical usage keeps the price that was valid at the time, and the raw
// usage persisted in ai_usage_records can be re-priced at any moment.
//
// Seed prices are the providers' PUBLIC LIST PRICES as found on their pricing
// pages in September 2026 (source_note says where). They are not invoices:
// the operator should confirm/adjust them in Dashboard -> Расходы.
// A model without a matching row is reported as "unpriced" (cost null),
// never silently guessed.

const CATEGORIES = Object.freeze({
    REALTIME_GEMINI: 'realtime_gemini',
    REALTIME_GROK: 'realtime_grok',
    LLM_TEXT: 'llm_text',
    EMBEDDING: 'embedding',
    WEB_SEARCH: 'web_search',
    TTS: 'tts',
    OTHER: 'other',
});

const CATEGORY_LABELS = Object.freeze({
    realtime_gemini: 'Realtime voice · Gemini Live',
    realtime_grok: 'Realtime voice · Grok/xAI',
    llm_text: 'LLM / text calls',
    embedding: 'Embeddings',
    web_search: 'Web search grounding',
    tts: 'Voice preview TTS',
    other: 'Other AI calls',
});

const BILLING_UNITS = new Set(['tokens', 'audio_minute', 'request']);

const DEFAULT_PRICING = Object.freeze([
    {
        id: 'gemini-3.1-flash-live-preview@2026-01-01',
        provider: 'gemini',
        model: 'gemini-3.1-flash-live-preview',
        category: CATEGORIES.REALTIME_GEMINI,
        billing_unit: 'tokens',
        currency: 'USD',
        unit_prices: {
            text_input_per_1m: 0.75,
            audio_input_per_1m: 3.00,
            text_output_per_1m: 4.50,
            audio_output_per_1m: 12.00,
            // Used ONLY for the fallback estimate when a session has no
            // provider usage metadata at all (measured audio seconds -> tokens).
            audio_tokens_per_second: 25,
        },
        effective_from: '2026-01-01',
        effective_to: null,
        source_note: 'Google Gemini API paid-tier list price (ai.google.dev/gemini-api/docs/pricing), checked 2026-09. Cached-token discount not modelled.',
    },
    {
        id: 'grok-voice-latest@2026-01-01',
        provider: 'grok',
        model: 'grok-voice-latest',
        category: CATEGORIES.REALTIME_GROK,
        billing_unit: 'audio_minute',
        currency: 'USD',
        unit_prices: { per_audio_minute: 0.05 },
        effective_from: '2026-01-01',
        effective_to: '2026-08-05',
        source_note: 'xAI Grok Voice Agent API launch price $0.05/min (x.ai/news/grok-voice-agent-api); superseded when grok-voice-latest moved to Think Fast 2.0.',
    },
    {
        id: 'grok-voice-latest@2026-08-05',
        provider: 'grok',
        model: 'grok-voice-latest',
        category: CATEGORIES.REALTIME_GROK,
        billing_unit: 'audio_minute',
        currency: 'USD',
        unit_prices: { per_audio_minute: 0.08 },
        effective_from: '2026-08-05',
        effective_to: null,
        source_note: 'xAI API pricing page (x.ai/api/voice), Think Fast 2.0 $0.08 per audio minute, checked 2026-09. Billed minutes estimated from measured session time.',
    },
    {
        id: 'gemini-2.5-flash@2026-01-01',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        category: CATEGORIES.LLM_TEXT,
        billing_unit: 'tokens',
        currency: 'USD',
        unit_prices: { text_input_per_1m: 0.30, audio_input_per_1m: 1.00, text_output_per_1m: 2.50 },
        effective_from: '2026-01-01',
        effective_to: null,
        source_note: 'Google Gemini API paid-tier list price, checked 2026-09. Thinking tokens billed as output.',
    },
    {
        id: 'gemini-2.5-flash-grounding@2026-01-01',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        category: CATEGORIES.WEB_SEARCH,
        billing_unit: 'request',
        currency: 'USD',
        unit_prices: { per_1k_requests: 35 },
        effective_from: '2026-01-01',
        effective_to: null,
        source_note: 'Grounding with Google Search list price $35/1K grounded prompts. The free daily allowance is NOT modelled, so this is an upper bound.',
    },
    {
        id: 'gemini-embedding-001@2026-01-01',
        provider: 'gemini',
        model: 'gemini-embedding-001',
        category: CATEGORIES.EMBEDDING,
        billing_unit: 'tokens',
        currency: 'USD',
        unit_prices: { input_per_1m: 0.15, chars_per_token: 4 },
        effective_from: '2026-01-01',
        effective_to: null,
        source_note: 'Google Gemini API list price. The embeddings API returns no token count; tokens are estimated from characters.',
    },
]);

function toDateKey(value) {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function validatePricingRow(row) {
    const errors = [];
    if (!row || typeof row !== 'object') return ['row_required'];
    for (const key of ['provider', 'model', 'category', 'billing_unit', 'effective_from']) {
        if (!row[key] || typeof row[key] !== 'string') errors.push(`${key}_required`);
    }
    if (row.billing_unit && !BILLING_UNITS.has(row.billing_unit)) errors.push('billing_unit_invalid');
    if (row.currency && !['USD', 'EUR', 'MDL'].includes(row.currency)) errors.push('currency_invalid');
    if (row.effective_from && !/^\d{4}-\d{2}-\d{2}$/.test(row.effective_from)) errors.push('effective_from_invalid');
    if (row.effective_to && !/^\d{4}-\d{2}-\d{2}$/.test(row.effective_to)) errors.push('effective_to_invalid');
    const prices = row.unit_prices;
    if (!prices || typeof prices !== 'object') errors.push('unit_prices_required');
    else {
        for (const [key, value] of Object.entries(prices)) {
            if (!Number.isFinite(Number(value)) || Number(value) < 0) errors.push(`unit_prices.${key}_invalid`);
        }
    }
    return errors;
}

// Picks the pricing row valid for (provider, model, category) at `at`.
// Exact model match only; the newest effective_from that is <= the usage
// date wins, so adding a new row with a later effective date re-prices only
// usage from that date forward.
function resolvePrice(pricingRows, { provider, model, category, at }) {
    const day = toDateKey(at || new Date());
    let best = null;
    for (const row of pricingRows || []) {
        if (row.provider !== provider || row.model !== model || row.category !== category) continue;
        const from = toDateKey(row.effective_from);
        const to = toDateKey(row.effective_to);
        if (from && day < from) continue;
        if (to && day >= to) continue;
        if (!best || toDateKey(best.effective_from) < from) best = row;
    }
    return best;
}

function perMillion(tokens, price) {
    return (num(tokens) * num(price)) / 1e6;
}

// Pure: normalized usage (see usageNormalize.js) + pricing row -> cost in
// the row's currency. `basis` says how trustworthy the NUMBERS are:
//   actual    — usage units came from the provider's own usage metadata;
//   estimated — usage (or part of it) was derived from local measurement.
function computeUsageCost(usage, basis, price) {
    if (!price) return { cost: null, currency: null, basis: basis || 'estimated', priced: false, method: 'no_price' };
    const u = usage || {};
    const p = price.unit_prices || {};
    let cost = 0;
    let effectiveBasis = basis === 'actual' ? 'actual' : 'estimated';
    let method;

    if (price.billing_unit === 'audio_minute') {
        const seconds = num(u.billable_seconds) || (num(u.audio_input_seconds) + num(u.audio_output_seconds));
        cost = (seconds / 60) * num(p.per_audio_minute);
        // Per-minute billing is always derived from our own clock.
        effectiveBasis = 'estimated';
        method = 'measured_minutes';
    } else if (price.billing_unit === 'request') {
        cost = (num(u.requests) / 1000) * num(p.per_1k_requests);
        method = 'requests';
    } else {
        const hasTokens = ['input_text_tokens', 'input_audio_tokens', 'input_other_tokens',
            'output_text_tokens', 'output_audio_tokens', 'output_other_tokens']
            .some((key) => num(u[key]) > 0);
        if (hasTokens) {
            const textIn = p.text_input_per_1m ?? p.input_per_1m;
            const audioIn = p.audio_input_per_1m ?? p.input_per_1m ?? textIn;
            const textOut = p.text_output_per_1m ?? p.output_per_1m;
            const audioOut = p.audio_output_per_1m ?? p.output_per_1m ?? textOut;
            cost += perMillion(u.input_text_tokens, textIn);
            cost += perMillion(u.input_audio_tokens, audioIn);
            cost += perMillion(u.output_text_tokens, textOut);
            cost += perMillion(u.output_audio_tokens, audioOut);
            if (num(u.input_other_tokens) > 0 || num(u.output_other_tokens) > 0) {
                // Modality not itemized by the provider: price at the higher
                // rate (conservative) and flag the cost as estimated.
                cost += perMillion(u.input_other_tokens, p.input_per_1m ?? Math.max(num(textIn), num(audioIn)));
                cost += perMillion(u.output_other_tokens, p.output_per_1m ?? Math.max(num(textOut), num(audioOut)));
                effectiveBasis = 'estimated';
            }
            method = 'tokens';
        } else if (num(u.input_chars) > 0 && num(p.chars_per_token) > 0) {
            cost = perMillion(num(u.input_chars) / num(p.chars_per_token), p.input_per_1m ?? p.text_input_per_1m);
            effectiveBasis = 'estimated';
            method = 'chars_to_tokens';
        } else if ((num(u.audio_input_seconds) > 0 || num(u.audio_output_seconds) > 0) && num(p.audio_tokens_per_second) > 0) {
            const rate = num(p.audio_tokens_per_second);
            cost = perMillion(num(u.audio_input_seconds) * rate, p.audio_input_per_1m)
                + perMillion(num(u.audio_output_seconds) * rate, p.audio_output_per_1m);
            effectiveBasis = 'estimated';
            method = 'audio_seconds_to_tokens';
        } else {
            method = 'no_usage';
        }
    }
    return { cost, currency: price.currency || 'USD', basis: effectiveBasis, priced: true, method, pricing_id: price.id };
}

// Currency conversion. Rates are configuration (cost_settings), not code:
//   eur_to_mdl — MDL per 1 EUR; usd_to_eur — EUR per 1 USD.
function convert(amount, currency, rates) {
    if (amount === null || amount === undefined) return { eur: null, mdl: null };
    const eurToMdl = num(rates?.eur_to_mdl);
    const usdToEur = num(rates?.usd_to_eur);
    let eur;
    if (currency === 'EUR') eur = num(amount);
    else if (currency === 'MDL') eur = eurToMdl > 0 ? num(amount) / eurToMdl : 0;
    else eur = num(amount) * usdToEur;
    return { eur, mdl: eur * eurToMdl };
}

module.exports = {
    CATEGORIES,
    CATEGORY_LABELS,
    DEFAULT_PRICING,
    validatePricingRow,
    resolvePrice,
    computeUsageCost,
    convert,
    toDateKey,
};

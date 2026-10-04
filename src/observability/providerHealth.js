'use strict';

// Provider health (observation only). Two signals for the "Gemini credits
// ran out" failure, which otherwise shows up only as guests hearing nothing:
//   1. observe(): realtime session log lines (gemini_error, gemini_close,
//      provider_error, grok_*) are classified; quota/billing and auth errors
//      are kept in a small in-memory ring with timestamps.
//   2. probeGemini(): one tiny text call with the same API key (same Google
//      project and billing as Gemini Live). A depleted prepaid balance or a
//      revoked key fails it even when nobody is talking.
// GET /api/provider-health exposes both; the provider-health workflow fails
// (GitHub e-mails the owner) when either says the provider is unusable.
// Runbook: docs/RUNBOOK_PROVIDER_DOWN.md.

const RING_SIZE = 100;
const PROVIDER_STAGES = /^(gemini_error|gemini_close|provider_error|provider_failed|grok_[a-z_]*error|grok_[a-z_]*failed)$/;

const ring = [];

function classify(text) {
    const s = String(text || '');
    if (!s) return null;
    if (/credit|prepa(y|id)|billing|quota|RESOURCE_EXHAUSTED|exceeded your|\b429\b|insufficient (funds|balance)|spending (cap|limit)/i.test(s)) return 'quota';
    if (/api[ _-]?key|UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|unauthori[sz]ed|invalid (key|token)/i.test(s)) return 'auth';
    return null;
}

function providerOf(stage) {
    if (/^grok_/.test(stage)) return 'grok';
    if (/^gemini_/.test(stage)) return 'gemini';
    return 'provider';
}

// Called for every realtime log line; cheap no-op for unrelated stages.
function observe(stage, extra = {}, now = Date.now()) {
    if (!PROVIDER_STAGES.test(String(stage || ''))) return null;
    const text = [extra.message, extra.reason, extra.error, extra.code].filter(Boolean).join(' ');
    const kind = classify(text);
    if (!kind && stage === 'gemini_close') return null; // ordinary close
    const entry = { at: now, stage, provider: extra.provider || providerOf(stage), kind: kind || 'other', message: String(text).slice(0, 200) };
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
    return entry;
}

function recent({ sinceMs = 60 * 60 * 1000, now = Date.now() } = {}) {
    return ring.filter((e) => now - e.at <= sinceMs);
}

function summary({ sinceMs = 60 * 60 * 1000, now = Date.now() } = {}) {
    const items = recent({ sinceMs, now });
    const counts = { quota: 0, auth: 0, other: 0 };
    for (const e of items) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const last = (kind) => {
        const e = [...items].reverse().find((x) => x.kind === kind);
        return e ? { at: new Date(e.at).toISOString(), stage: e.stage, provider: e.provider, message: e.message } : null;
    };
    return { window_minutes: Math.round(sinceMs / 60000), counts, last_quota: last('quota'), last_auth: last('auth'), last_other: last('other') };
}

// One-token text call. Uses a text model on purpose: same key and billing
// as Live, but no Live session (no audio, no slot), cost ~ $0.000001.
async function probeGemini({
    apiKey = process.env.GEMINI_API_KEY || '',
    model = process.env.PROVIDER_HEALTH_PROBE_MODEL || 'gemini-2.5-flash',
    timeoutMs = 10000,
    generate = null,
} = {}) {
    if (!apiKey && !generate) return { ok: false, kind: 'auth', error: 'gemini_api_key_missing' };
    const startedAt = Date.now();
    try {
        const call = generate || (async () => {
            const { GoogleGenAI } = await import('@google/genai');
            const ai = new GoogleGenAI({ apiKey });
            return ai.models.generateContent({ model, contents: 'ok', config: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } } });
        });
        await Promise.race([
            call(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('probe_timeout')), timeoutMs)),
        ]);
        return { ok: true, model, ms: Date.now() - startedAt };
    } catch (error) {
        const message = String(error?.message || error).slice(0, 300);
        const kind = classify(message) || (message === 'probe_timeout' ? 'timeout' : 'other');
        return { ok: false, model, kind, error: message, ms: Date.now() - startedAt };
    }
}

// Cached probe for the public /health/provider (an external uptime monitor
// polls it every few minutes): at most one Gemini call per ttlMs however
// often it is hit.
let probeCache = { at: 0, result: null, pending: null };
async function cachedProbe({ ttlMs = 5 * 60 * 1000, now = Date.now, probe = probeGemini } = {}) {
    if (probeCache.result && now() - probeCache.at < ttlMs) return probeCache.result;
    if (probeCache.pending) return probeCache.pending;
    probeCache.pending = Promise.resolve(probe()).then((result) => {
        probeCache = { at: now(), result, pending: null };
        return result;
    }, (error) => {
        probeCache.pending = null;
        return { ok: false, kind: 'other', error: String(error?.message || error).slice(0, 200) };
    });
    return probeCache.pending;
}

// A successful live probe is the truth about "usable now": session errors
// from before a top-up must not keep the alarm red (prod 2026-10-04: credits
// topped up, probe ok, but 8 earlier session quota errors kept failing it).
function verdict({ probe = null, sessions }) {
    if (probe) return probe.ok === true;
    return sessions.counts.quota === 0 && sessions.counts.auth === 0;
}

function grokConfigured(env = process.env) {
    return Boolean(env.GROK_API_KEY || env.XAI_API_KEY);
}

module.exports = {
    classify,
    observe,
    recent,
    summary,
    probeGemini,
    grokConfigured,
    cachedProbe,
    verdict,
    _reset: () => { ring.length = 0; probeCache = { at: 0, result: null, pending: null }; },
};

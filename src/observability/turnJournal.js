'use strict';

// Turn journal (ai_turns): one row per assistant turn -- what the guest said,
// which tools ran and what they found, what the model answered, tokens, cost
// and latency. Observation only: realtimeServer.js hands finished turns to
// record(); writes are fire-and-forget and can never throw into the
// conversation. See docs/TURN_JOURNAL.md.
//
// Env:
//   TURN_JOURNAL=off                  -- record nothing
//   TURN_JOURNAL_TEXT=off             -- keep question/answer text out
//   TURN_JOURNAL_RETENTION_DAYS=30    -- rows older than this are purged

const db = require('../knowledge/db');
const { DEFAULT_PRICING, CATEGORIES, resolvePrice, computeUsageCost } = require('../cost/pricing');
const { emptyUsage, addUsage, normalizeGeminiUsage, normalizeRealtimeCompatUsage } = require('../cost/usageNormalize');

const TEXT_MAX = 2000;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

function enabled(env = process.env) {
    return !/^(0|false|no|off)$/i.test(String(env.TURN_JOURNAL || ''));
}
function textEnabled(env = process.env) {
    return !/^(0|false|no|off)$/i.test(String(env.TURN_JOURNAL_TEXT || ''));
}
function retentionDays(env = process.env) {
    const days = Number(env.TURN_JOURNAL_RETENTION_DAYS);
    return Number.isFinite(days) && days >= 1 ? Math.min(365, Math.round(days)) : 30;
}

function clip(value, max = TEXT_MAX) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : null;
}

// ---- tool results -> compact, model-independent summary ----------------------

function evidenceSummary(item) {
    if (!item || typeof item !== 'object') return null;
    const meta = item.metadata || item.provenance || {};
    const id = item.id || item.chunk_id || meta.chunk_id || item.entity_id || meta.product_id || meta.wine_entity_id || null;
    const score = Number(item.relevance_score ?? item.score);
    return {
        level: item.level || null,
        id: id ? String(id).slice(0, 80) : null,
        title: clip(item.title || item.entity_name, 80),
        score: Number.isFinite(score) ? Math.round(score * 1000) / 1000 : null,
        source: item.source_type || null,
    };
}

function summarizeToolResult(name, raw, ms) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const evidence = Array.isArray(r.evidence) ? r.evidence.slice(0, 10).map(evidenceSummary).filter(Boolean) : [];
    return {
        name,
        ms: Number.isFinite(ms) ? Math.round(ms) : null,
        ok: !r.error,
        found: typeof r.found === 'boolean' ? r.found : null,
        evidence,
        levels: Array.isArray(r.used_levels) ? r.used_levels : [...new Set(evidence.map((e) => e.level).filter(Boolean))],
        web: Boolean(r.web_used),
        answerable: typeof r.answerable === 'boolean' ? r.answerable : null,
        screen_cards: Array.isArray(r.screen_cards) ? r.screen_cards.length : 0,
        shown_in_chat: Array.isArray(r.shown_in_chat) ? r.shown_in_chat.length : 0,
        error: r.error ? String(r.error).slice(0, 80) : null,
    };
}

// Wraps the session's tool handlers (outermost, before the model-facing
// budget) to observe each call: name, duration and the raw result summary.
function observeToolHandlers(handlers, onResult) {
    if (!handlers || typeof handlers !== 'object' || typeof onResult !== 'function') return handlers;
    const wrapped = { ...handlers };
    for (const [name, handler] of Object.entries(handlers)) {
        if (typeof handler !== 'function') continue;
        wrapped[name] = async (call) => {
            const startedAt = Date.now();
            const result = await handler(call);
            try { onResult({ name, generationId: call && call.generationId, summary: summarizeToolResult(name, result, Date.now() - startedAt) }); } catch { /* observation only */ }
            return result;
        };
    }
    return wrapped;
}

function normalizeUsage(raw, kind) {
    return kind === 'realtime_usage' ? normalizeRealtimeCompatUsage(raw) : normalizeGeminiUsage(raw);
}

function costUsd({ provider, model, usage }) {
    const category = provider === 'gemini' ? CATEGORIES.REALTIME_GEMINI : provider === 'grok' ? CATEGORIES.REALTIME_GROK : CATEGORIES.OTHER;
    const price = resolvePrice(DEFAULT_PRICING, { provider, model, category, at: new Date() });
    if (!price || !usage) return null;
    const out = computeUsageCost(usage, 'actual', price);
    return out.priced && out.currency === 'USD' && Number.isFinite(out.cost) ? Math.round(out.cost * 1e6) / 1e6 : null;
}

// ---- per-session collector -----------------------------------------------------

// One per realtime session. Generations are keyed by generation id; usage
// (which Gemini reports at turnComplete, after the turn's audio) is added to
// the generation it belongs to, and the row is written shortly after the
// turn ends so that usage can still arrive.
function createTurnCollector({ base = {}, write, delayMs = Number(process.env.TURN_JOURNAL_DELAY_MS) || 2500, now = () => Date.now() } = {}) {
    const turns = new Map();
    let lastId = null;

    function entry(generationId, startedAt) {
        let t = turns.get(generationId);
        if (!t) {
            t = { generationId, turnId: null, startedAt: startedAt || now(), tools: [], usage: null, firstAudioAt: 0, flags: {} };
            turns.set(generationId, t);
            if (turns.size > 50) turns.delete(turns.keys().next().value);
        }
        return t;
    }

    function get(generation) {
        if (!generation || !generation.generationId) return null;
        const t = entry(generation.generationId, generation.createdAt);
        if (generation.createdAt && generation.createdAt < t.startedAt) t.startedAt = generation.createdAt;
        if (!t.turnId) t.turnId = generation.turnId || null;
        lastId = generation.generationId;
        return t;
    }

    return {
        noteTool({ generationId, summary }) {
            if (!generationId) return;
            const t = entry(generationId);
            if (!t.finished && t.tools.length < 12) t.tools.push(summary);
        },
        noteFirstAudio(generation) {
            const t = get(generation);
            if (t && !t.firstAudioAt) t.firstAudioAt = now();
        },
        noteFlag(generation, key, value = true) {
            const t = get(generation);
            if (t) t.flags[key] = value;
        },
        touch(generation) { get(generation); },
        // Usage reported by the provider: belongs to the current generation,
        // else the last one seen (Gemini reports it at turnComplete).
        noteUsage(currentGeneration, raw, kind) {
            const t = (currentGeneration && turns.get(currentGeneration.generationId)) || (lastId && turns.get(lastId));
            if (!t || !raw) return;
            const normalized = normalizeUsage(raw, kind);
            if (normalized) t.usage = addUsage(t.usage || emptyUsage(), normalized);
        },
        finish(generation, { outcome, reason = null, question = null, answer = null, language = null, voice = null } = {}) {
            const t = get(generation);
            if (!t || t.finished) return;
            t.finished = true;
            // A turn that never had content (e.g. an empty Free Conversation
            // turn superseded by the next utterance) is not worth a row.
            if (!String(question || '').trim() && !String(answer || '').trim() && !t.tools.length) {
                turns.delete(t.generationId);
                return;
            }
            const endedAt = now();
            const timer = setTimeout(() => {
                turns.delete(t.generationId);
                const usage = t.usage;
                const row = {
                    ...base,
                    id: t.generationId,
                    turn_id: t.turnId,
                    started_at: new Date(t.startedAt).toISOString(),
                    ended_at: new Date(endedAt).toISOString(),
                    language,
                    voice,
                    mode: generation.mode || null,
                    outcome,
                    outcome_reason: reason ? String(reason).slice(0, 64) : null,
                    question: clip(question),
                    answer: clip(answer),
                    tools: t.tools,
                    usage,
                    cost_usd: usage ? costUsd({ provider: base.provider, model: base.model, usage }) : null,
                    first_audio_ms: t.firstAudioAt ? t.firstAudioAt - t.startedAt : null,
                    total_ms: endedAt - t.startedAt,
                    flags: t.flags,
                };
                try { write(row); } catch { /* observation only */ }
            }, delayMs);
            timer.unref?.();
        },
    };
}

// ---- store -----------------------------------------------------------------------

async function applySchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ai_turns (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn_id TEXT,
            started_at TIMESTAMPTZ NOT NULL,
            ended_at TIMESTAMPTZ NOT NULL,
            channel TEXT,
            provider TEXT,
            model TEXT,
            voice TEXT,
            language TEXT,
            mode TEXT,
            access_grant TEXT,
            outcome TEXT NOT NULL,
            outcome_reason TEXT,
            question TEXT,
            answer TEXT,
            tools JSONB NOT NULL DEFAULT '[]'::jsonb,
            usage JSONB,
            cost_usd NUMERIC,
            first_audio_ms INTEGER,
            total_ms INTEGER,
            flags JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS ai_turns_started_idx ON ai_turns (started_at DESC);
        CREATE INDEX IF NOT EXISTS ai_turns_session_idx ON ai_turns (session_id);
    `);
}

const COLUMNS = ['id', 'session_id', 'turn_id', 'started_at', 'ended_at', 'channel', 'provider', 'model', 'voice', 'language', 'mode', 'access_grant',
    'outcome', 'outcome_reason', 'question', 'answer', 'tools', 'usage', 'cost_usd', 'first_audio_ms', 'total_ms', 'flags'];
const JSON_COLUMNS = new Set(['tools', 'usage', 'flags']);

function createPostgresTurnStore(poolProvider = () => db.getPool()) {
    let ready = null;
    let lastPurge = 0;
    const pool = () => {
        const p = poolProvider();
        if (!p) throw Object.assign(new Error('turn_store_unavailable'), { code: 'turn_store_unavailable' });
        return p;
    };
    const init = () => {
        if (!ready) ready = applySchema(pool()).catch((error) => { ready = null; throw error; });
        return ready;
    };
    async function purge(days) {
        if (Date.now() - lastPurge < PURGE_EVERY_MS) return;
        lastPurge = Date.now();
        await pool().query(`DELETE FROM ai_turns WHERE started_at < NOW() - ($1::int * INTERVAL '1 day')`, [days]);
    }
    return {
        backend: 'postgres',
        init,
        async insert(row, { days = 30 } = {}) {
            await init();
            const values = COLUMNS.map((c) => (JSON_COLUMNS.has(c) ? JSON.stringify(row[c] ?? (c === 'tools' ? [] : c === 'flags' ? {} : null)) : (row[c] ?? null)));
            await pool().query(
                `INSERT INTO ai_turns (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT (id) DO NOTHING`,
                values,
            );
            await purge(days).catch(() => {});
        },
        async list({ from = null, to = null, sessionId = null, limit = 200 } = {}) {
            await init();
            const where = [];
            const params = [];
            if (from) { params.push(from); where.push(`started_at >= $${params.length}`); }
            if (to) { params.push(to); where.push(`started_at < $${params.length}`); }
            if (sessionId) { params.push(sessionId); where.push(`session_id = $${params.length}`); }
            params.push(Math.max(1, Math.min(2000, Number(limit) || 200)));
            const { rows } = await pool().query(
                `SELECT ${COLUMNS.join(', ')} FROM ai_turns ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT $${params.length}`,
                params,
            );
            return rows;
        },
        async updateFlags(id, flags) {
            await init();
            await pool().query(`UPDATE ai_turns SET flags = flags || $2::jsonb WHERE id = $1`, [id, JSON.stringify(flags || {})]);
        },
    };
}

function createMemoryTurnStore() {
    const rows = [];
    return {
        backend: 'memory',
        async init() {},
        async insert(row) { if (!rows.some((r) => r.id === row.id)) rows.push(JSON.parse(JSON.stringify(row))); },
        async list({ sessionId = null, limit = 200 } = {}) {
            return rows.filter((r) => !sessionId || r.session_id === sessionId).slice(-limit).reverse();
        },
        async updateFlags(id, flags) { const r = rows.find((x) => x.id === id); if (r) r.flags = { ...(r.flags || {}), ...flags }; },
        _rows: rows,
    };
}

let defaultStore = null;
function getTurnStore() {
    if (!defaultStore) {
        defaultStore = (process.env.DATABASE_URL && process.env.DATABASE_URL !== 'memory')
            ? createPostgresTurnStore()
            : createMemoryTurnStore();
    }
    return defaultStore;
}

// Fire-and-forget write used by realtimeServer.js. Never throws.
// enrich: optional async (row) => row run before the insert (e.g. the
// "not from the catalog" name check); it sees the text even when
// TURN_JOURNAL_TEXT=off drops it from the stored row.
function recordTurn(row, { store = getTurnStore(), env = process.env, log = () => {}, onRecorded = null, enrich = null } = {}) {
    if (!enabled(env) || !row) return;
    let out = row;
    Promise.resolve()
        .then(() => (typeof enrich === 'function' ? Promise.resolve(enrich(row)).catch(() => row) : row))
        .then((enriched) => {
            out = enriched || row;
            if (!textEnabled(env)) out = { ...out, question: null, answer: null };
            return store.insert(out, { days: retentionDays(env) });
        })
        .then(() => { if (typeof onRecorded === 'function') onRecorded(out); })
        .catch((error) => log('turn_journal_write_failed', { message: String(error?.message || error).slice(0, 160) }));
}

module.exports = {
    createTurnCollector,
    observeToolHandlers,
    summarizeToolResult,
    recordTurn,
    getTurnStore,
    createPostgresTurnStore,
    createMemoryTurnStore,
    enabled,
    textEnabled,
    retentionDays,
    costUsd,
};

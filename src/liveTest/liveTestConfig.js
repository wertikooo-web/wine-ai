'use strict';

// Closed-beta Test Control (CONTROL PLANE only).
//
// The operator edits a draft in the Dashboard and presses
// "APPLY TO NEW SESSIONS": the complete, validated config is published as a
// new revision. Participant sessions (Wine AI Lite, channel=lite) take an
// immutable snapshot of the published revision ONCE, when their WebSocket is
// created; publishing never touches a running session. Dashboard sessions
// keep using the ordinary Settings (personaStore) exactly as before.
//
// Source of truth is PostgreSQL (in-memory backend for tests / no DB). The
// process keeps the last successfully loaded published revision so session
// creation is synchronous and never waits on the database.

const db = require('../knowledge/db');
const { BUILTIN_PROFILES, STYLE_ENUMS } = require('../persona/profileRegistry');
const { GEMINI_VOICE_NAMES } = require('../geminiVoices');
const { GROK_VOICES } = require('../grokVoices');

const PROVIDERS = Object.freeze(['gemini', 'grok']);
const KNOWLEDGE_MODES = Object.freeze(['database_first', 'database_only']);
const PRESET_SLOTS = Object.freeze(['A', 'B', 'C', 'D']);
const CONFIG_FIELDS = Object.freeze(['provider', 'voice', 'persona', 'mood', 'responseLength', 'tone', 'expertiseLevel', 'conversationMode', 'knowledgeMode']);

// Seed presets (editable from the Dashboard). Baseline is seeded from A and
// can be overwritten with "Save draft as baseline".
const SEED_PRESETS = Object.freeze({
    A: { label: 'Gemini Warm', config: { provider: 'gemini', voice: 'Sulafat', persona: 'warm_guide', mood: 'warm', responseLength: 'balanced', tone: 'warm', expertiseLevel: 'balanced', conversationMode: 'friendly', knowledgeMode: 'database_first' } },
    B: { label: 'Gemini Expert', config: { provider: 'gemini', voice: 'Kore', persona: 'warm_guide', mood: 'expert', responseLength: 'balanced', tone: 'formal', expertiseLevel: 'expert', conversationMode: 'friendly', knowledgeMode: 'database_first' } },
    C: { label: 'Grok Warm', config: { provider: 'grok', voice: 'eve', persona: 'warm_guide', mood: 'warm', responseLength: 'balanced', tone: 'warm', expertiseLevel: 'balanced', conversationMode: 'friendly', knowledgeMode: 'database_first' } },
    D: { label: 'Grok Expert', config: { provider: 'grok', voice: 'eve', persona: 'warm_guide', mood: 'expert', responseLength: 'balanced', tone: 'formal', expertiseLevel: 'expert', conversationMode: 'friendly', knowledgeMode: 'database_first' } },
});

function voicesFor(provider) {
    if (provider === 'gemini') return GEMINI_VOICE_NAMES.map((name) => ({ id: name, name }));
    if (provider === 'grok') return GROK_VOICES.map((v) => ({ id: v.id, name: v.name }));
    return [];
}

function canonicalVoice(provider, voice) {
    const wanted = String(voice || '').trim().toLowerCase();
    const match = voicesFor(provider).find((v) => v.id.toLowerCase() === wanted || v.name.toLowerCase() === wanted);
    return match ? match.id : null;
}

// Full validation of a complete config. `isProviderConfigured` lets the
// server reject a provider whose API key is missing in this deployment.
function validateConfig(input, { isProviderConfigured = () => true } = {}) {
    const errors = [];
    const c = input && typeof input === 'object' ? input : {};
    const config = {};
    for (const key of Object.keys(c)) if (!CONFIG_FIELDS.includes(key) && key !== 'label') errors.push(`unknown_field:${key}`);
    if (!PROVIDERS.includes(c.provider)) errors.push('invalid_provider');
    else if (!isProviderConfigured(c.provider)) errors.push('provider_not_configured');
    else config.provider = c.provider;
    if (config.provider) {
        const voice = canonicalVoice(config.provider, c.voice);
        if (!voice) errors.push('invalid_voice_for_provider');
        else config.voice = voice;
    }
    if (!Object.prototype.hasOwnProperty.call(BUILTIN_PROFILES, c.persona)) errors.push('invalid_persona');
    else config.persona = c.persona;
    for (const field of ['mood', 'responseLength', 'tone', 'expertiseLevel', 'conversationMode']) {
        if (!STYLE_ENUMS[field].includes(c[field])) errors.push(`invalid_${field}`);
        else config[field] = c[field];
    }
    if (!KNOWLEDGE_MODES.includes(c.knowledgeMode)) errors.push('invalid_knowledgeMode');
    else config.knowledgeMode = c.knowledgeMode;
    return { config: errors.length ? null : config, errors };
}

function describeConfig(config) {
    if (!config) return '';
    const personaName = BUILTIN_PROFILES[config.persona]?.personaName || config.persona;
    return [config.provider, personaName, config.voice, config.mood, config.responseLength,
        config.knowledgeMode === 'database_only' ? 'database only' : 'database first']
        .map((x) => String(x).toUpperCase()).join(' · ');
}

function diffConfigs(previous, next) {
    const changes = [];
    for (const field of CONFIG_FIELDS) {
        const a = previous ? previous[field] : undefined;
        const b = next ? next[field] : undefined;
        if (a !== b) changes.push({ field, from: a ?? null, to: b ?? null });
    }
    return changes;
}

// ---------------------------------------------------------------------
// Stores (same interface): Postgres and in-memory
// ---------------------------------------------------------------------

async function applySchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS live_test_state (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS live_test_revisions (
            revision INTEGER PRIMARY KEY,
            published_at TIMESTAMPTZ NOT NULL,
            label TEXT,
            previous_config JSONB,
            new_config JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_test_sessions (
            session_id TEXT PRIMARY KEY,
            started_at TIMESTAMPTZ NOT NULL,
            config_revision INTEGER,
            snapshot JSONB NOT NULL,
            language TEXT,
            ended_at TIMESTAMPTZ
        );
        CREATE TABLE IF NOT EXISTS live_test_feedback (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            conversation_score SMALLINT,
            voice_score SMALLINT,
            comment TEXT,
            config_revision INTEGER
        );
    `);
}

function createPostgresLiveTestStore(poolProvider = () => db.getPool()) {
    let ready = null;
    const pool = () => {
        const p = poolProvider();
        if (!p) throw Object.assign(new Error('live_test_store_unavailable'), { code: 'live_test_store_unavailable' });
        return p;
    };
    const init = () => {
        if (!ready) ready = applySchema(pool()).catch((error) => { ready = null; throw error; });
        return ready;
    };
    const getKey = async (key) => {
        await init();
        const { rows } = await pool().query('SELECT value FROM live_test_state WHERE key = $1', [key]);
        return rows.length ? rows[0].value : null;
    };
    const setKey = async (key, value, client = null) => {
        await (client || pool()).query(
            `INSERT INTO live_test_state (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, JSON.stringify(value)],
        );
    };
    return {
        backend: 'postgres',
        init,
        getKey,
        async setKey(key, value) { await init(); await setKey(key, value); },
        // Atomic: revision number, published row and history row in one
        // transaction; a concurrent publish serializes on the row lock.
        async publish(config, label) {
            await init();
            const client = await pool().connect();
            try {
                await client.query('BEGIN');
                await client.query(`INSERT INTO live_test_state (key, value) VALUES ('published', 'null') ON CONFLICT DO NOTHING`);
                const { rows } = await client.query(`SELECT value FROM live_test_state WHERE key = 'published' FOR UPDATE`);
                const previous = rows[0]?.value || null;
                const revision = (previous?.revision || 0) + 1;
                const published = { revision, config, label: label || null, published_at: new Date().toISOString() };
                await setKey('published', published, client);
                await client.query(
                    `INSERT INTO live_test_revisions (revision, published_at, label, previous_config, new_config) VALUES ($1, $2, $3, $4, $5)`,
                    [revision, published.published_at, published.label, JSON.stringify(previous?.config || null), JSON.stringify(config)],
                );
                await client.query('COMMIT');
                return published;
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch { /* ignore */ }
                throw error;
            } finally {
                client.release();
            }
        },
        async listRevisions(limit = 50) {
            await init();
            const { rows } = await pool().query('SELECT * FROM live_test_revisions ORDER BY revision DESC LIMIT $1', [limit]);
            return rows.map((r) => ({ revision: r.revision, published_at: new Date(r.published_at).toISOString(), label: r.label, previous_config: r.previous_config, new_config: r.new_config }));
        },
        async recordSession(row) {
            await init();
            await pool().query(
                `INSERT INTO live_test_sessions (session_id, started_at, config_revision, snapshot) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO NOTHING`,
                [row.session_id, row.started_at, row.config_revision, JSON.stringify(row.snapshot)],
            );
        },
        async closeSession({ session_id, language, ended_at }) {
            await init();
            await pool().query('UPDATE live_test_sessions SET language = COALESCE($2, language), ended_at = $3 WHERE session_id = $1', [session_id, language || null, ended_at]);
        },
        async listSessions(limit = 300) {
            await init();
            const { rows } = await pool().query('SELECT * FROM live_test_sessions ORDER BY started_at DESC LIMIT $1', [limit]);
            return rows.map((r) => ({ session_id: r.session_id, started_at: new Date(r.started_at).toISOString(), ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null, config_revision: r.config_revision, snapshot: r.snapshot, language: r.language }));
        },
        async addFeedback(row) {
            await init();
            await pool().query(
                'INSERT INTO live_test_feedback (session_id, conversation_score, voice_score, comment, config_revision) VALUES ($1, $2, $3, $4, $5)',
                [row.session_id, row.conversation_score, row.voice_score, row.comment, row.config_revision],
            );
        },
        async listFeedback(limit = 1000) {
            await init();
            const { rows } = await pool().query('SELECT * FROM live_test_feedback ORDER BY created_at DESC LIMIT $1', [limit]);
            return rows.map((r) => ({ session_id: r.session_id, created_at: new Date(r.created_at).toISOString(), conversation_score: r.conversation_score, voice_score: r.voice_score, comment: r.comment, config_revision: r.config_revision }));
        },
    };
}

function createMemoryLiveTestStore(seed = {}) {
    const state = new Map(Object.entries(JSON.parse(JSON.stringify(seed))));
    const revisions = [];
    const sessions = new Map();
    const feedback = [];
    const copy = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
    return {
        backend: 'memory',
        async init() {},
        async getKey(key) { return copy(state.get(key)); },
        async setKey(key, value) { state.set(key, copy(value)); },
        async publish(config, label) {
            const previous = state.get('published') || null;
            const revision = (previous?.revision || 0) + 1;
            const published = { revision, config: copy(config), label: label || null, published_at: new Date().toISOString() };
            state.set('published', published);
            revisions.unshift({ revision, published_at: published.published_at, label: published.label, previous_config: copy(previous?.config), new_config: copy(config) });
            return copy(published);
        },
        async listRevisions(limit = 50) { return copy(revisions.slice(0, limit)); },
        async recordSession(row) { if (!sessions.has(row.session_id)) sessions.set(row.session_id, { ...copy(row), language: null, ended_at: null }); },
        async closeSession({ session_id, language, ended_at }) {
            const row = sessions.get(session_id);
            if (row) { if (language) row.language = language; row.ended_at = ended_at; }
        },
        async listSessions(limit = 300) { return copy([...sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit)); },
        async addFeedback(row) { feedback.unshift({ ...copy(row), created_at: new Date().toISOString() }); },
        async listFeedback(limit = 1000) { return copy(feedback.slice(0, limit)); },
        // test helper: what survives a "restart" is the store, not the service
        _dump() { return { state, revisions, sessions, feedback }; },
    };
}

function isPostgresConfigured() {
    return db.isEnabled() && process.env.DATABASE_URL !== 'memory';
}

// ---------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------

// getPersonaOverrides: current Settings overrides per persona (personaStore).
// They are frozen into each published revision so a revision is complete:
// editing a persona in Settings mid-test cannot change sessions of an
// already-published revision.
function createLiveTestService({ store, isProviderConfigured = () => true, getPersonaOverrides = () => ({}), log = (...a) => console.log('[LiveTest]', ...a) } = {}) {
    let published = null; // last successfully loaded/published revision (runtime cache)
    let loadState = 'not_loaded';

    async function load() {
        try {
            await store.init();
            published = await store.getKey('published');
            loadState = 'loaded';
        } catch (error) {
            loadState = 'failed';
            log('load_failed', String(error?.message || error).slice(0, 200));
        }
        return published;
    }

    async function getPresets() {
        const stored = (await store.getKey('presets')) || {};
        const out = {};
        for (const slot of PRESET_SLOTS) out[slot] = stored[slot] || SEED_PRESETS[slot];
        return out;
    }

    async function getBaseline() {
        return (await store.getKey('baseline')) || { label: 'Baseline', config: SEED_PRESETS.A.config };
    }

    async function publish(config, label) {
        const { config: clean, errors } = validateConfig(config, { isProviderConfigured });
        if (errors.length) return { ok: false, errors };
        let personaOverrides = {};
        try { personaOverrides = JSON.parse(JSON.stringify((getPersonaOverrides() || {})[clean.persona]?.overrides || {})); } catch { personaOverrides = {}; }
        const result = await store.publish({ ...clean, personaOverrides }, typeof label === 'string' ? label.slice(0, 60) : null);
        published = result;
        log('published', JSON.stringify({ revision: result.revision, config: describeConfig(clean) }));
        return { ok: true, published: result };
    }

    async function savePreset(slot, label, config) {
        if (!PRESET_SLOTS.includes(slot)) return { ok: false, errors: ['invalid_slot'] };
        const { config: clean, errors } = validateConfig(config, { isProviderConfigured: () => true });
        if (errors.length) return { ok: false, errors };
        const presets = await getPresets();
        presets[slot] = { label: String(label || presets[slot]?.label || slot).slice(0, 40), config: clean };
        await store.setKey('presets', presets);
        return { ok: true, presets };
    }

    async function saveBaseline(config) {
        const { config: clean, errors } = validateConfig(config, { isProviderConfigured: () => true });
        if (errors.length) return { ok: false, errors };
        const baseline = { label: 'Baseline', config: clean, saved_at: new Date().toISOString() };
        await store.setKey('baseline', baseline);
        return { ok: true, baseline };
    }

    // Called once at WebSocket creation for a participant (lite) session.
    // Synchronous; returns a frozen snapshot or null (nothing published /
    // store unavailable -> the session uses the ordinary Settings, logged).
    function snapshotForNewSession() {
        if (!published || !published.config) {
            log('snapshot_unavailable', loadState === 'failed' ? 'store_load_failed_using_settings' : 'nothing_published_using_settings');
            return null;
        }
        const { personaOverrides, ...config } = published.config;
        return Object.freeze({
            revision: published.revision,
            label: published.label,
            config: Object.freeze(config),
            // null for revisions published before overrides were frozen in:
            // those fall back to the live Settings overrides (logged).
            personaOverrides: personaOverrides ? Object.freeze(personaOverrides) : null,
        });
    }

    // Persona state in the same shape as personaStore.getCached(), built once
    // from the snapshot + the persona's stored text overrides (name, prompts,
    // identity stay whatever Settings holds; only the tested fields change).
    function personaStateFor(snapshot, profilesOverrides = {}) {
        const c = snapshot.config;
        if (!snapshot.personaOverrides) log('persona_overrides_live_fallback', `revision ${snapshot.revision} has no frozen persona overrides`);
        const base = JSON.parse(JSON.stringify(snapshot.personaOverrides || profilesOverrides[c.persona]?.overrides || {}));
        delete base.mood;
        base.style = { ...(base.style || {}), responseLength: c.responseLength, tone: c.tone, expertiseLevel: c.expertiseLevel, conversationMode: c.conversationMode };
        base.runtimeByProvider = { ...(base.runtimeByProvider || {}), [c.provider]: { voiceId: c.voice } };
        return Object.freeze({ baseProfileId: c.persona, mood: c.mood, overrides: base });
    }

    function recordSessionStart({ sessionId, snapshot, model, resolvedVoice }) {
        Promise.resolve().then(() => store.recordSession({
            session_id: sessionId,
            started_at: new Date().toISOString(),
            config_revision: snapshot.revision,
            snapshot: { ...snapshot.config, label: snapshot.label, model: model || null, resolved_voice: resolvedVoice || null },
        })).catch((error) => log('record_session_failed', String(error?.message || error).slice(0, 200)));
    }

    function recordSessionEnd({ sessionId, language }) {
        Promise.resolve().then(() => store.closeSession({ session_id: sessionId, language: language || null, ended_at: new Date().toISOString() }))
            .catch((error) => log('close_session_failed', String(error?.message || error).slice(0, 200)));
    }

    return {
        load,
        getPublished: () => published,
        getLoadState: () => loadState,
        getPresets,
        getBaseline,
        publish,
        savePreset,
        saveBaseline,
        snapshotForNewSession,
        personaStateFor,
        recordSessionStart,
        recordSessionEnd,
        store,
    };
}

module.exports = {
    PROVIDERS,
    KNOWLEDGE_MODES,
    PRESET_SLOTS,
    CONFIG_FIELDS,
    SEED_PRESETS,
    voicesFor,
    validateConfig,
    describeConfig,
    diffConfigs,
    createPostgresLiveTestStore,
    createMemoryLiveTestStore,
    createLiveTestService,
    isPostgresConfigured,
};

'use strict';

// /api/live-test/* — Dashboard Test Control (operator) + participant
// feedback. Writes by the operator require x-admin-token when ADMIN_TOKEN is
// set (same rule as /api/cost/*). Feedback is open to participants but
// strictly validated. No provider/model names ever go to the Lite client:
// the Lite client only calls POST /api/live-test/feedback.

const crypto = require('crypto');
const { BUILTIN_PROFILES, STYLE_ENUMS } = require('../persona/profileRegistry');
const { PROVIDERS, KNOWLEDGE_MODES, PRESET_SLOTS, voicesFor, describeConfig, diffConfigs } = require('./liveTestConfig');

function isWriteAllowed(req) {
    const token = process.env.ADMIN_TOKEN || '';
    if (!token) return true;
    const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function median(values) {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function average(values) {
    const v = values.filter((x) => Number.isFinite(x));
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
}

function createLiveTestApi({ service, sendJson, readJsonBody, isProviderConfigured = () => true, listUsageRecords = async () => [] }) {
    function options() {
        return {
            providers: PROVIDERS.map((id) => ({ id, label: id === 'gemini' ? 'Gemini Live' : 'Grok Voice', configured: isProviderConfigured(id), voices: voicesFor(id) })),
            personas: Object.values(BUILTIN_PROFILES).map((p) => ({ id: p.id, name: p.personaName, defaults: { mood: p.mood, ...p.style } })),
            enums: STYLE_ENUMS,
            knowledgeModes: KNOWLEDGE_MODES,
            presetSlots: PRESET_SLOTS,
        };
    }

    async function state() {
        const [presets, baseline, revisions] = await Promise.all([service.getPresets(), service.getBaseline(), service.store.listRevisions(30)]);
        const published = service.getPublished();
        return {
            ok: true,
            storage: service.store.backend,
            load_state: service.getLoadState(),
            published,
            published_description: published ? describeConfig(published.config) : null,
            presets,
            baseline,
            history: revisions.map((r) => ({ revision: r.revision, published_at: r.published_at, label: r.label, changes: diffConfigs(r.previous_config, r.new_config) })),
            options: options(),
        };
    }

    async function results() {
        const [sessions, feedback] = await Promise.all([service.store.listSessions(500), service.store.listFeedback(2000)]);
        let usage = [];
        if (sessions.length) {
            const from = sessions[sessions.length - 1].started_at;
            try {
                usage = await listUsageRecords({ from: new Date(new Date(from).getTime() - 60000).toISOString(), to: new Date(Date.now() + 60000).toISOString() });
            } catch { usage = []; }
        }
        const usageBySession = new Map(usage.filter((r) => r.kind === 'realtime_session').map((r) => [r.session_id, r]));
        const feedbackBySession = new Map();
        for (const f of feedback) if (!feedbackBySession.has(f.session_id)) feedbackBySession.set(f.session_id, f);
        const rows = sessions.map((s) => {
            const u = usageBySession.get(s.session_id);
            const f = feedbackBySession.get(s.session_id);
            return {
                session_id: s.session_id,
                started_at: s.started_at,
                config_revision: s.config_revision,
                label: s.snapshot?.label || null,
                config: s.snapshot,
                language: s.language,
                duration_ms: u?.duration_ms ?? (s.ended_at ? new Date(s.ended_at) - new Date(s.started_at) : null),
                turn_count: u?.turn_count ?? null,
                provider_connections: u?.provider_connections ?? null,
                end_reason: u?.end_reason ?? null,
                status: u?.status ?? null,
                conversation_score: f?.conversation_score ?? null,
                voice_score: f?.voice_score ?? null,
                comment: f?.comment ?? null,
            };
        });
        const groups = new Map();
        for (const r of rows) {
            const key = `${r.config_revision}`;
            if (!groups.has(key)) groups.set(key, { config_revision: r.config_revision, label: r.label, description: describeConfig(r.config), sessions: [] });
            groups.get(key).sessions.push(r);
        }
        const by_revision = [...groups.values()].map((g) => ({
            config_revision: g.config_revision,
            label: g.label,
            description: g.description,
            sessions: g.sessions.length,
            rated: g.sessions.filter((s) => s.conversation_score).length,
            avg_conversation: average(g.sessions.map((s) => s.conversation_score)),
            avg_voice: average(g.sessions.map((s) => s.voice_score)),
            median_duration_s: (() => { const m = median(g.sessions.map((s) => s.duration_ms)); return m === null ? null : Math.round(m / 1000); })(),
            median_turns: median(g.sessions.map((s) => s.turn_count)),
            languages: [...new Set(g.sessions.map((s) => s.language).filter(Boolean))],
        }));
        return { ok: true, by_revision, sessions: rows };
    }

    async function handle(req, res, pathname) {
        if (!pathname.startsWith('/api/live-test/')) return false;
        const method = req.method;
        try {
            if (method === 'POST' && pathname === '/api/live-test/feedback') {
                const body = await readJsonBody(req, 8 * 1024);
                const sessionId = String(body.session_id || '');
                const score = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);
                const conversation = score(body.conversation_score);
                const voice = score(body.voice_score);
                if (!/^session_[a-z0-9]{8,40}$/i.test(sessionId) || (conversation === null && voice === null)) {
                    sendJson(res, 400, { ok: false, error: 'invalid_feedback' });
                    return true;
                }
                const sessions = await service.store.listSessions(1000);
                const session = sessions.find((s) => s.session_id === sessionId);
                if (!session) { sendJson(res, 404, { ok: false, error: 'unknown_session' }); return true; }
                await service.store.addFeedback({
                    session_id: sessionId,
                    conversation_score: conversation,
                    voice_score: voice,
                    comment: String(body.comment || '').trim().slice(0, 1000) || null,
                    config_revision: session.config_revision,
                });
                sendJson(res, 200, { ok: true });
                return true;
            }
            if (method === 'GET' && pathname === '/api/live-test/state') { sendJson(res, 200, await state()); return true; }
            if (method === 'GET' && pathname === '/api/live-test/results') { sendJson(res, 200, await results()); return true; }

            if (method === 'POST' && !isWriteAllowed(req)) { sendJson(res, 401, { ok: false, error: 'admin_token_required' }); return true; }

            if (method === 'POST' && pathname === '/api/live-test/publish') {
                const body = await readJsonBody(req);
                const result = await service.publish(body.config, body.label);
                sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, published: result.published, published_description: describeConfig(result.published.config) } : { ok: false, error: 'invalid_config', details: result.errors });
                return true;
            }
            const presetMatch = /^\/api\/live-test\/presets\/([A-D])$/.exec(pathname);
            if (method === 'POST' && presetMatch) {
                const body = await readJsonBody(req);
                const result = await service.savePreset(presetMatch[1], body.label, body.config);
                sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ok: false, error: 'invalid_config', details: result.errors });
                return true;
            }
            if (method === 'POST' && pathname === '/api/live-test/baseline') {
                const body = await readJsonBody(req);
                const result = await service.saveBaseline(body.config);
                sendJson(res, result.ok ? 200 : 400, result.ok ? result : { ok: false, error: 'invalid_config', details: result.errors });
                return true;
            }
            sendJson(res, 404, { ok: false, error: 'not_found' });
            return true;
        } catch (error) {
            if (error?.code === 'invalid_json' || error?.code === 'body_too_large') {
                sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code });
                return true;
            }
            console.warn('[LiveTestApi] request_failed', pathname, String(error?.message || error).slice(0, 200));
            sendJson(res, 503, { ok: false, error: 'live_test_unavailable' });
            return true;
        }
    }

    return { handle };
}

module.exports = { createLiveTestApi };

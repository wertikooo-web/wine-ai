'use strict';

// Closed-beta Test Control (control plane): validation, draft/preset/baseline
// never publish, revisions + history, persistence across a service restart,
// and session isolation over real WebSockets (a session keeps the config it
// was created with; publishing never touches running sessions).

process.env.DATABASE_URL = process.env.DATABASE_URL || 'memory';

const http = require('http');
const t = require('./helpers/assertions');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { connect } = require('./helpers/wsTestClient');
const { createLiveTestService, createMemoryLiveTestStore, validateConfig, SEED_PRESETS, diffConfigs } = require('../src/liveTest/liveTestConfig');
const { createLiveTestApi } = require('../src/liveTest/liveTestApi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

const GEMINI = { ...SEED_PRESETS.A.config };
const GROK = { ...SEED_PRESETS.C.config };

function startServer(service, resolvedProviders) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => res.end());
        const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 10, chunkCount: 1, chunkIntervalMs: 5 });
        attachRealtimeServer(server, {
            providerMetadata: { provider: 'mock', model: 'mock', contentToolsEnabled: false },
            resolveProvider: (requested) => {
                const id = requested || 'gemini';
                resolvedProviders.push(id);
                return {
                    id,
                    metadata: { provider: id, model: `${id}-model`, contentToolsEnabled: false, rotationMode: 'errors_only' },
                    createSession: (options) => mock.createSession(options),
                };
            },
            liveTest: service,
        });
        server.listen(0, () => resolve({ port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } }));
    });
}

async function openSession(port, path = '/realtime?channel=lite') {
    const client = await connect(port, path);
    await client.waitFor((e) => e.type === 'session.ready');
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied');
    return client;
}

async function run() {
    // ---- validation --------------------------------------------------------
    t.ok(validateConfig(GEMINI).config, 'seed preset A is valid');
    t.ok(validateConfig({ ...GEMINI, provider: 'openai' }).errors.includes('invalid_provider'), 'unknown provider rejected');
    t.ok(validateConfig({ ...GEMINI, voice: 'eve' }).errors.includes('invalid_voice_for_provider'), 'Grok voice on Gemini rejected');
    t.ok(validateConfig({ ...GROK, voice: 'Sulafat' }).errors.includes('invalid_voice_for_provider'), 'Gemini voice on Grok rejected');
    t.ok(validateConfig({ ...GEMINI, persona: 'pirate' }).errors.includes('invalid_persona'), 'unknown persona rejected');
    t.ok(validateConfig({ ...GEMINI, mood: 'angry' }).errors.includes('invalid_mood'), 'invented mood rejected');
    t.ok(validateConfig({ ...GEMINI, knowledgeMode: 'web_only' }).errors.includes('invalid_knowledgeMode'), 'unknown knowledge mode rejected');
    t.ok(validateConfig({ ...GEMINI }, { isProviderConfigured: (id) => id !== 'gemini' }).errors.includes('provider_not_configured'), 'unconfigured provider rejected');
    t.equal(validateConfig({ ...GROK, voice: 'Eve' }).config.voice, 'eve', 'voice name is canonicalised to the provider id');

    // ---- publish / presets / baseline / history -----------------------------
    const store = createMemoryLiveTestStore();
    const service = createLiveTestService({ store, log: quiet });
    await service.load();
    t.equal(service.getPublished(), null, 'nothing published initially');
    t.equal(service.snapshotForNewSession(), null, 'no snapshot before first publish (sessions use Settings)');

    const bad = await service.publish({ ...GEMINI, voice: 'eve' });
    t.equal(bad.ok, false, 'invalid publish refused');
    t.equal(service.getPublished(), null, 'refused publish changes nothing (no partial config)');

    await service.savePreset('B', 'Mine', GROK);
    t.equal(service.getPublished(), null, 'saving a preset does not publish');
    t.equal((await service.getPresets()).B.label, 'Mine', 'preset saved');
    await service.saveBaseline(GROK);
    t.equal(service.getPublished(), null, 'saving the baseline does not publish');
    t.deepEqual((await service.getBaseline()).config, GROK, 'baseline stored explicitly');

    const r1 = await service.publish(GEMINI, 'A · Gemini Warm');
    t.equal(r1.published.revision, 1, 'first publish is revision 1');
    const r2 = await service.publish(GROK, 'C · Grok Warm');
    t.equal(r2.published.revision, 2, 'revision increments');
    const history = await store.listRevisions();
    t.equal(history.length, 2, 'history has both revisions');
    t.deepEqual(history[0].previous_config, GEMINI, 'history keeps previous config');
    t.deepEqual(history[0].new_config, GROK, 'history keeps new config');
    t.ok(diffConfigs(history[0].previous_config, history[0].new_config).some((c) => c.field === 'provider' && c.from === 'gemini' && c.to === 'grok'), 'diff shows Gemini → Grok');

    // restart simulation: new service instance over the same store
    const restarted = createLiveTestService({ store, log: quiet });
    await restarted.load();
    t.equal(restarted.getPublished().revision, 2, 'published config survives a service restart');
    t.deepEqual(restarted.getPublished().config, GROK, 'same config after restart');

    // store failure at load -> no invented config
    const broken = createLiveTestService({ store: { ...store, init: async () => { throw new Error('db down'); } }, log: quiet });
    await broken.load();
    t.equal(broken.snapshotForNewSession(), null, 'store failure: no arbitrary config is constructed');

    // ---- API: feedback + auth ------------------------------------------------
    {
        const api = createLiveTestApi({
            service,
            sendJson: (res, status, body) => { res.status = status; res.body = body; },
            readJsonBody: async (req) => req.body,
        });
        process.env.ADMIN_TOKEN = 'secret';
        const res = {};
        await api.handle({ method: 'POST', headers: {}, body: { config: GEMINI } }, res, '/api/live-test/publish');
        t.equal(res.status, 401, 'publish requires the admin token when set');
        const ok = {};
        await api.handle({ method: 'POST', headers: { 'x-admin-token': 'secret' }, body: { config: GEMINI, label: 'A' } }, ok, '/api/live-test/publish');
        t.equal(ok.status, 200, 'publish with token ok');
        t.equal(ok.body.published.revision, 3, 'API publish is a new revision');
        delete process.env.ADMIN_TOKEN;
    }

    // ---- session isolation over real WebSockets ------------------------------
    {
        const liveStore = createMemoryLiveTestStore();
        const live = createLiveTestService({ store: liveStore, log: quiet });
        await live.load();
        await live.publish({ ...GEMINI }, 'A');
        const providers = [];
        const server = await startServer(live, providers);
        try {
            const a = await openSession(server.port);
            const b = await openSession(server.port);
            await live.publish({ ...GROK }, 'C');
            const c = await openSession(server.port);
            await live.publish({ ...GROK, voice: 'ara' }, 'C voice');
            const d = await openSession(server.port);
            // A and B are still alive after two publications
            for (const [name, client] of [['A', a], ['B', b]]) {
                client.sendJson({ type: 'input_text.submit', text: 'Привет' });
                const reply = await client.waitFor((e) => e.type === 'audio.end' || e.type === 'response.failed' || e.type === 'response.completed' || e.type === 'transcript.model', { timeoutMs: 4000 }).catch(() => null);
                t.ok(reply, `session ${name} still answers after publishing`);
            }
            // dashboard session (no channel) ignores Test Control
            const dash = await openSession(server.port, '/realtime?provider=gemini');
            await sleep(100);
            t.deepEqual(providers, ['gemini', 'gemini', 'grok', 'grok', 'gemini'], 'A,B created on Gemini; C,D on Grok; dashboard uses its own provider');
            const sessions = await liveStore.listSessions();
            const byRevision = sessions.map((s) => [s.config_revision, s.snapshot.provider, s.snapshot.resolved_voice]).sort((x, y) => x[0] - y[0] || String(x[2]).localeCompare(String(y[2])));
            t.deepEqual(byRevision, [[1, 'gemini', 'Sulafat'], [1, 'gemini', 'Sulafat'], [2, 'grok', 'eve'], [3, 'grok', 'ara']], 'each session recorded the snapshot it actually started with (incl. resolved voice)');
            t.equal(sessions.length, 4, 'dashboard session is not recorded as a test session');
            for (const client of [a, b, c, d, dash]) { client.sendCloseFrame(); client.close(); }
            await sleep(100);
            const closed = await liveStore.listSessions();
            t.ok(closed.every((s) => s.ended_at), 'session end recorded on close');

            // participant feedback is tied to the session's revision
            const api = createLiveTestApi({ service: live, sendJson: (res, status, body) => { res.status = status; res.body = body; }, readJsonBody: async (req) => req.body });
            const target = closed.find((s) => s.config_revision === 2);
            const fb = {};
            await api.handle({ method: 'POST', headers: {}, body: { session_id: target.session_id, conversation_score: 5, voice_score: 4, comment: 'ok' } }, fb, '/api/live-test/feedback');
            t.equal(fb.status, 200, 'feedback accepted without admin token');
            const badFb = {};
            await api.handle({ method: 'POST', headers: {}, body: { session_id: target.session_id, conversation_score: 9 } }, badFb, '/api/live-test/feedback');
            t.equal(badFb.status, 400, 'out-of-range score rejected');
            const unknown = {};
            await api.handle({ method: 'POST', headers: {}, body: { session_id: 'session_doesnotexist1', conversation_score: 3 } }, unknown, '/api/live-test/feedback');
            t.equal(unknown.status, 404, 'feedback for an unknown session rejected');
            const results = {};
            await api.handle({ method: 'GET', headers: {} }, results, '/api/live-test/results');
            const rev2 = results.body.by_revision.find((r) => r.config_revision === 2);
            t.equal(rev2.avg_conversation, 5, 'results aggregate scores per revision');
            t.equal(rev2.rated, 1, 'one rated session for revision 2');
        } finally {
            server.close();
        }
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('liveTestControl tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

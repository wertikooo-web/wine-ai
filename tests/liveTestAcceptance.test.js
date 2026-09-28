'use strict';

// Live Test Control — end-to-end acceptance: for every setting, a published
// revision is proven to reach the layer it controls in a real /lite
// WebSocket session (attachRealtimeServer, channel=lite):
//   provider  -> which provider the session is created on
//   voice     -> options.voiceName handed to that provider, and the real
//                provider payload (Gemini speechConfig / Grok session.update)
//   persona / mood / responseLength / tone / expertiseLevel /
//   conversationMode -> the system instruction the provider receives
//   knowledgeMode -> web availability in the session's tools
// plus revision immutability (a running session never changes) and the
// frozen persona text (Settings edits after publishing do not leak in).

process.env.DATABASE_URL = process.env.DATABASE_URL || 'memory';

const http = require('http');
const t = require('./helpers/assertions');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { connect } = require('./helpers/wsTestClient');
const { createLiveTestService, createMemoryLiveTestStore, SEED_PRESETS } = require('../src/liveTest/liveTestConfig');
const { BUILTIN_PROFILES, STYLE_ENUMS, buildMoodInstruction, buildStyleInstruction } = require('../src/persona/profileRegistry');
const { buildGeminiSpeechConfig } = require('../src/realtime/geminiLiveProvider');
const { buildGrokSessionConfig } = require('../src/realtime/grokVoiceProvider');
const { bindTool } = require('../src/tools/toolHelpers');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');

const quiet = () => {};
const BASE = { ...SEED_PRESETS.A.config };

async function startServer(service, getPersonaOverridesLive) {
    const sessions = []; // one entry per provider session created
    const toolContexts = [];
    const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 5, chunkCount: 1, chunkIntervalMs: 5 });
    const server = http.createServer((req, res) => res.end());
    attachRealtimeServer(server, {
        providerMetadata: { provider: 'mock', model: 'mock', contentToolsEnabled: false },
        resolveProvider: (requested) => {
            const id = requested || 'gemini';
            return {
                id,
                metadata: {
                    provider: id,
                    model: `${id}-model`,
                    contentToolsEnabled: false,
                    rotationMode: 'errors_only',
                    createToolHandlers: (ctx) => { toolContexts.push(ctx); return {}; },
                },
                createSession: (options) => { sessions.push({ provider: id, options }); return mock.createSession(options); },
            };
        },
        liveTest: service,
    });
    await new Promise((r) => server.listen(0, r));
    return { port: server.address().port, sessions, toolContexts, close: () => { server.closeAllConnections?.(); server.close(); } };
}

async function openLite(env) {
    const before = env.sessions.length;
    const client = await connect(env.port, '/realtime?channel=lite');
    await client.waitFor((e) => e.type === 'session.ready');
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied');
    // the provider session created for session.start carries the resolved config
    const created = env.sessions.slice(before);
    return { client, provider: created[created.length - 1], toolContext: env.toolContexts[env.toolContexts.length - 1] };
}

async function run() {
    const store = createMemoryLiveTestStore();
    let settingsOverrides = { warm_guide: { overrides: {} }, classic: { overrides: {} } };
    const service = createLiveTestService({ store, log: quiet, getPersonaOverrides: () => settingsOverrides });
    await service.load();
    const env = await startServer(service);
    const opened = [];
    const publishAndOpen = async (patch) => {
        const result = await service.publish({ ...BASE, ...patch });
        t.ok(result.ok, `publish ${JSON.stringify(patch)}`);
        const session = await openLite(env);
        opened.push(session.client);
        return { ...session, revision: result.published.revision };
    };
    const prompt = (s) => String(s.provider.options.systemInstructionText || '');

    try {
        // ---- provider ------------------------------------------------------
        for (const [provider, voice] of [['gemini', 'Sulafat'], ['grok', 'eve']]) {
            const s = await publishAndOpen({ provider, voice });
            t.equal(s.provider.provider, provider, `provider=${provider}: session created on ${provider}`);
        }

        // ---- voice (and the real provider payload) ----------------------------
        for (const voice of ['Kore', 'Charon', 'Sulafat']) {
            const s = await publishAndOpen({ provider: 'gemini', voice });
            t.equal(s.provider.options.voiceName, voice, `gemini voice=${voice}: voiceName handed to provider`);
            t.equal(buildGeminiSpeechConfig(s.provider.options.voiceName).voiceConfig.prebuiltVoiceConfig.voiceName, voice, `gemini voice=${voice}: speechConfig payload`);
        }
        for (const voice of ['eve', 'ara', 'rex']) {
            const s = await publishAndOpen({ provider: 'grok', voice });
            t.equal(s.provider.options.voiceName, voice, `grok voice=${voice}: voiceName handed to provider`);
            t.equal(buildGrokSessionConfig(s.provider.options, {}).voice, voice, `grok voice=${voice}: session.update voice`);
        }
        t.equal((await service.publish({ ...BASE, provider: 'grok', voice: 'Kore' })).ok, false, 'Gemini voice on Grok refused at publish (no silent substitution)');
        t.equal((await service.publish({ ...BASE, provider: 'gemini', voice: 'eve' })).ok, false, 'Grok voice on Gemini refused at publish');

        // ---- persona ---------------------------------------------------------
        for (const persona of ['warm_guide', 'classic']) {
            const other = persona === 'warm_guide' ? 'classic' : 'warm_guide';
            const s = await publishAndOpen({ persona });
            const p = prompt(s);
            t.ok(p.includes(`Ты — ${BUILTIN_PROFILES[persona].personaName}.`), `persona=${persona}: name in prompt`);
            t.ok(p.includes(BUILTIN_PROFILES[persona].personalityPrompt), `persona=${persona}: personality in prompt`);
            t.ok(p.includes(BUILTIN_PROFILES[persona].identity.background), `persona=${persona}: identity in prompt`);
            t.ok(!p.includes(`Ты — ${BUILTIN_PROFILES[other].personaName}.`), `persona=${persona}: other persona absent`);
        }

        // ---- mood / responseLength / tone / expertise / conversationMode -------
        for (const mood of STYLE_ENUMS.mood) {
            const p = prompt(await publishAndOpen({ mood }));
            t.ok(p.includes(buildMoodInstruction(mood)), `mood=${mood}: in prompt`);
            for (const other of STYLE_ENUMS.mood.filter((m) => m !== mood)) t.ok(!p.includes(buildMoodInstruction(other)), `mood=${mood}: ${other} absent`);
        }
        const styleCases = [['responseLength', STYLE_ENUMS.responseLength], ['tone', STYLE_ENUMS.tone], ['expertiseLevel', STYLE_ENUMS.expertiseLevel]];
        for (const [field, values] of styleCases) {
            for (const value of values) {
                const p = prompt(await publishAndOpen({ [field]: value }));
                t.ok(p.includes(buildStyleInstruction({ [field]: value })), `${field}=${value}: in prompt`);
                for (const other of values.filter((v) => v !== value)) t.ok(!p.includes(buildStyleInstruction({ [field]: other })), `${field}=${value}: ${other} absent`);
            }
        }
        const MODE_MARKER = { strict: 'CONVERSATION MODE: STRICT', friendly: 'CONVERSATION MODE: FRIENDLY', free: 'CONVERSATION MODE: FREE TALK' };
        for (const mode of STYLE_ENUMS.conversationMode) {
            const p = prompt(await publishAndOpen({ conversationMode: mode }));
            t.ok(p.includes(MODE_MARKER[mode]), `conversationMode=${mode}: in prompt`);
            for (const other of Object.keys(MODE_MARKER).filter((m) => m !== mode)) t.ok(!p.includes(MODE_MARKER[other]), `conversationMode=${mode}: ${other} absent`);
        }

        // ---- knowledgeMode ---------------------------------------------------
        for (const [mode, webExpected] of [['database_first', true], ['database_only', false]]) {
            const s = await publishAndOpen({ knowledgeMode: mode });
            t.equal(s.toolContext.isWebSearchEnabled(), webExpected, `knowledgeMode=${mode}: session web switch`);
            const routed = [];
            const tool = createImpl(async (q, opts) => { routed.push(opts); return { found: false, evidence: [], used_levels: [], web_used: false, answerable: false, conflicts: [], answer_policy: {} }; });
            await tool({ query: 'Что такое терруар?', force_web: true }, s.toolContext);
            t.equal(routed[0].allowWeb, webExpected, `knowledgeMode=${mode}: search_wine_knowledge allowWeb=${webExpected} (force_web included)`);
            const webTool = bindTool({ name: 'search_web', impl: async () => ({ ok: true }) }, s.toolContext);
            const webResult = await webTool({ args: { query: 'x' }, generationId: 'g1' });
            t.equal(webResult.ok === true, webExpected, `knowledgeMode=${mode}: search_web ${webExpected ? 'allowed' : 'refused'}`);
        }

        // ---- whole revision, immutability, frozen persona text -----------------
        settingsOverrides = { warm_guide: { overrides: { personalityPrompt: 'ТЕКСТ НА МОМЕНТ ПУБЛИКАЦИИ' } }, classic: { overrides: {} } };
        const full = { provider: 'grok', voice: 'ara', persona: 'warm_guide', mood: 'lively', responseLength: 'brief', tone: 'lively', expertiseLevel: 'beginnerFriendly', conversationMode: 'free', knowledgeMode: 'database_only' };
        const a = await publishAndOpen(full);
        const promptA = prompt(a);
        t.ok(promptA.includes('ТЕКСТ НА МОМЕНТ ПУБЛИКАЦИИ'), 'persona text from Settings at publish time is used');
        settingsOverrides = { warm_guide: { overrides: { personalityPrompt: 'ПРАВКА ПОСЛЕ ПУБЛИКАЦИИ' } }, classic: { overrides: {} } };
        const a2 = await openLite(env); opened.push(a2.client);
        t.ok(prompt(a2).includes('ТЕКСТ НА МОМЕНТ ПУБЛИКАЦИИ') && !prompt(a2).includes('ПРАВКА ПОСЛЕ ПУБЛИКАЦИИ'), 'a Settings edit after publishing does not leak into the revision');
        t.equal(a2.provider.provider, 'grok', 'same revision -> same provider');
        t.equal(a2.provider.options.voiceName, 'ara', 'same revision -> same voice');
        t.equal(prompt(a2), promptA, 'same revision -> identical resolved prompt');

        const rotationsBefore = env.sessions.length;
        await service.publish({ ...BASE, provider: 'gemini', voice: 'Kore', mood: 'calm' });
        // the running session A is asked to re-apply its config (as a client could)
        a.client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await a.client.waitFor((e) => e.type === 'session.config.applied');
        const reapplied = env.sessions.slice(rotationsBefore).filter((x) => x.provider === 'grok').pop();
        t.ok(reapplied, 'running session stays on its original provider after a new publish');
        t.equal(reapplied.options.voiceName, 'ara', 'running session keeps its voice');
        t.equal(String(reapplied.options.systemInstructionText), promptA, 'running session keeps its full resolved prompt');
        const b = await openLite(env); opened.push(b.client);
        t.equal(b.provider.provider, 'gemini', 'next session gets the new revision (provider)');
        t.equal(b.provider.options.voiceName, 'Kore', 'next session gets the new revision (voice)');
        t.ok(prompt(b).includes(buildMoodInstruction('calm')), 'next session gets the new revision (mood)');
    } finally {
        for (const client of opened) { try { client.sendCloseFrame(); client.close(); } catch { /* ignore */ } }
        env.close();
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('liveTestAcceptance passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

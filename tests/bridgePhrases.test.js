'use strict';

// Bridge phrases ("Минуточку, сейчас посмотрю.") while a knowledge search keeps the assistant
// silent. Unit coverage of the scheduler/cache plus an end-to-end run through
// the real realtime server with a provider whose tool call takes a while.

const http = require('http');
const t = require('./helpers/assertions');
const { connect } = require('./helpers/wsTestClient');
const { PHRASES, bridgeConfig, normalizeLanguage, createBridgeAudioCache, createBridgeScheduler } = require('../src/realtime/bridgePhrases');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCache() {
    return {
        warmed: [],
        warm(voice) { this.warmed.push(voice); return Promise.resolve(); },
        get: (voice, lang, index) => ({ audioBase64: Buffer.from(`${voice}|${lang}|${index}`).toString('base64'), sampleRate: 24000 }),
    };
}

async function unit() {
    t.equal(bridgeConfig({}).enabled, false, 'off by default');
    t.equal(bridgeConfig({ BRIDGE_PHRASES_ENABLED: 'true' }).enabled, true, 'flag enables');
    t.equal(normalizeLanguage('ro-MD'), 'ro');
    t.equal(normalizeLanguage('de'), 'ru', 'unknown language falls back to Russian');
    for (const lang of ['ru', 'ro', 'en']) t.ok(PHRASES[lang].length >= 3, `${lang}: several phrases (no repetition tic)`);

    const on = { enabled: true, delayMs: 30, minTurnGap: 2 };
    {
        const sent = [];
        const s = createBridgeScheduler({ config: on, cache: fakeCache(), emit: (e) => sent.push(e), getVoice: () => 'Kore', getLanguage: () => 'ro' });
        t.ok(s.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 }), 'scheduled');
        await sleep(60);
        t.equal(sent.length, 1, 'bridge sent after the delay');
        t.equal(sent[0].type, 'assistant.bridge');
        t.equal(sent[0].generation_id, 'g1');
        t.equal(sent[0].language, 'ro', 'in the conversation language');
        t.ok(PHRASES.ro.includes(sent[0].text));
        t.ok(!s.onToolCall({ generationId: 'g2', turnId: 't2', turnNumber: 2 }), 'not on the very next turn (rate limit)');
        t.ok(s.onToolCall({ generationId: 'g3', turnId: 't3', turnNumber: 3 }), 'allowed again after the gap');
        await sleep(60);
        t.equal(sent.length, 2);
        t.ok(sent[1].text !== sent[0].text, 'phrases rotate');
    }
    {
        const sent = [];
        const s = createBridgeScheduler({ config: on, cache: fakeCache(), emit: (e) => sent.push(e), getVoice: () => 'Kore', getLanguage: () => 'ru' });
        s.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 });
        s.cancel('g1');
        await sleep(60);
        t.equal(sent.length, 0, 'answer started before the delay: no bridge');
        s.onToolCall({ generationId: 'g2', turnId: 't2', turnNumber: 5 });
        s.dispose();
        await sleep(60);
        t.equal(sent.length, 0, 'disposed (session closed): no bridge');
    }
    {
        const sent = [];
        const off = createBridgeScheduler({ config: { ...on, enabled: false }, cache: fakeCache(), emit: (e) => sent.push(e), getVoice: () => 'Kore' });
        t.ok(!off.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 }), 'flag off: nothing scheduled');
        const noVoice = createBridgeScheduler({ config: on, cache: fakeCache(), emit: (e) => sent.push(e), getVoice: () => null });
        t.ok(!noVoice.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 }), 'no voice (non-Gemini provider): nothing scheduled');
        const notRendered = createBridgeScheduler({ config: on, cache: { warm: () => Promise.resolve(), get: () => null }, emit: (e) => sent.push(e), getVoice: () => 'Kore' });
        notRendered.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 });
        await sleep(60);
        t.equal(sent.length, 0, 'phrase not rendered yet: skipped, never blocks');
    }
    {
        let calls = 0;
        let clock = 0;
        const cache = createBridgeAudioCache({
            synthesize: async ({ text }) => { calls += 1; if (text === PHRASES.en[1]) throw new Error('tts down'); return { audioBase64: 'AAAA', sampleRate: 24000 }; },
            sleep: async () => {}, now: () => clock, retryCooldownMs: 1000,
        });
        await Promise.all([cache.warm('Kore'), cache.warm('Kore')]);
        const total = PHRASES.ru.length + PHRASES.ro.length + PHRASES.en.length;
        t.equal(calls, total + 1, 'each phrase rendered once per voice (concurrent warm deduplicated); a failed one retried once');
        t.equal(cache.size(), total - 1, 'a failed render is skipped, the rest are cached');
        t.equal(cache.get('Kore', 'en', 1), null);
        t.ok(cache.get('Kore', 'ru', 0));
        await cache.warm('Kore');
        t.equal(calls, total + 1, 'no re-render inside the cooldown');
        clock = 5000;
        await cache.warm('Kore');
        t.equal(calls, total + 3, 'after the cooldown only the missing phrase is re-rendered (with its retry)');
        t.equal(cache.status().rendered.Kore, total - 1);
    }
    {
        // Production 2026-09-29: Gemini TTS returned no audio for the first
        // Russian phrase with voice Leda; the scheduler never advanced past
        // it, so no bridge was ever sent. Empty audio must not be cached,
        // must be retried, and must not block the other phrases.
        let emptyCalls = 0;
        const cache = createBridgeAudioCache({
            synthesize: async ({ text }) => {
                if (text === PHRASES.ru[0]) { emptyCalls += 1; return { audioBase64: '' }; }
                return { audioBase64: 'AAAA', sampleRate: 24000 };
            },
            sleep: async () => {},
        });
        await cache.warm('Leda');
        t.equal(emptyCalls, 2, 'empty audio is retried once');
        t.equal(cache.get('Leda', 'ru', 0), null, 'empty audio is not cached');
        const sent = [];
        const logs = [];
        const s = createBridgeScheduler({ config: { enabled: true, delayMs: 10, minTurnGap: 1 }, cache, emit: (e) => sent.push(e), log: (stage, extra) => logs.push({ stage, ...extra }), getVoice: () => 'Leda', getLanguage: () => 'ru' });
        for (let turn = 1; turn <= 3; turn += 1) {
            s.onToolCall({ generationId: `g${turn}`, turnId: `t${turn}`, turnNumber: turn });
            await sleep(30);
        }
        t.equal(sent.length, 3, 'a missing phrase no longer blocks every later bridge');
        t.deepEqual(sent.map((e) => e.text), [PHRASES.ru[1], PHRASES.ru[2], PHRASES.ru[1]], 'rendered phrases rotate, the missing one is skipped (wrap-around)');
        t.ok(logs.some((l) => l.stage === 'bridge_sent'));
    }
    {
        const sent = [];
        const logs = [];
        let warmed = 0;
        const s = createBridgeScheduler({ config: { enabled: true, delayMs: 10, minTurnGap: 1 }, cache: { warm: () => { warmed += 1; return Promise.resolve(); }, get: () => null }, emit: (e) => sent.push(e), log: (stage, extra) => logs.push({ stage, ...extra }), getVoice: () => 'Leda', getLanguage: () => 'ru' });
        s.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 });
        await sleep(30);
        t.equal(sent.length, 0, 'nothing rendered: skipped');
        t.ok(logs.some((l) => l.stage === 'bridge_skipped' && l.reason === 'no_rendered_phrase'), 'skip is logged with its reason');
        t.equal(warmed, 2, 'and a re-render of the missing phrases is requested');
        s.onToolCall({ generationId: 'g2', turnId: 't2', turnNumber: 2 });
        s.cancel('g2');
        t.ok(logs.some((l) => l.stage === 'bridge_cancelled' && l.generationId === 'g2'), 'cancellation before the delay is logged');
    }
    for (const list of Object.values(PHRASES)) {
        for (const text of list) t.ok(!/…|\.\.\./.test(text) && text.length >= 12, `no ultra-short / ellipsis phrase (empty TTS audio): "${text}"`);
    }
}

async function endToEnd() {
    const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
    const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
    const run = async ({ enabled, toolMs, provider = 'gemini', language = null, transcript = [] }) => {
        const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 5, chunkCount: 1, chunkIntervalMs: 5 });
        const server = http.createServer((req, res) => res.end());
        attachRealtimeServer(server, {
            providerMetadata: { provider, model: 'm', contentToolsEnabled: false, defaultVoiceName: 'Kore' },
            providerFactory: (options) => {
                const session = mock.createSession(options);
                session.voiceName = 'Kore';
                const endInput = session.endInput.bind(session);
                session.endInput = async (ctx) => {
                    // Gemini streams the input transcription as fragments.
                    for (const text of transcript) ctx.onEvent({ type: 'transcript.user', response_id: ctx.responseId, turn_id: ctx.turnId, text });
                    ctx.onEvent({ type: 'tool.call', response_id: ctx.responseId, turn_id: ctx.turnId, tool_name: 'search_wine_knowledge' });
                    await sleep(toolMs);
                    return endInput(ctx);
                };
                return session;
            },
            bridgeConfig: { enabled, delayMs: 80, minTurnGap: 1 },
            bridgeCache: fakeCache(),
        });
        await new Promise((r) => server.listen(0, r));
        const client = await connect(server.address().port);
        try {
            await client.waitFor((e) => e.type === 'session.ready');
            client.sendJson({ type: 'session.start', sampleRate: 16000, ...(language ? { language } : {}) });
            await client.waitFor((e) => e.type === 'session.config.applied');
            client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
            await client.waitFor((e) => e.type === 'input_audio.start');
            client.sendBinary(Buffer.alloc(3200, 1));
            client.sendJson({ type: 'input_audio.end' });
            const seen = [];
            await client.waitFor((e) => { seen.push(e); return e.type === 'audio.end'; }, { timeoutMs: 6000 });
            await sleep(150);
            try { for (;;) seen.push(await client.nextEvent(20)); } catch { /* drained */ }
            return seen;
        } finally {
            client.close();
            server.closeAllConnections?.();
            server.close();
        }
    };
    const types = (events) => events.map((e) => e.type);

    const slow = types(await run({ enabled: true, toolMs: 300 }));
    t.ok(slow.includes('assistant.bridge'), 'slow tool call: bridge sent');
    t.ok(slow.indexOf('assistant.bridge') < slow.indexOf('audio.start'), 'bridge arrives before the real answer');
    t.equal(slow.filter((x) => x === 'audio.end').length, 1, 'turn completes normally (bridge does not touch turn state)');

    // Production 2026-09-30: a Russian conversation, the guest switches to
    // English. The first transcript fragment ("Tell") is too short to switch
    // the conversation language, so the bridge used to be Russian.
    const bridgeOf = (events) => events.find((e) => e.type === 'assistant.bridge');
    const switched = bridgeOf(await run({ enabled: true, toolMs: 300, language: 'ru', transcript: ['Tell', ' me about the best wineries please'] }));
    t.equal(switched && switched.language, 'en', 'language switch: bridge in the language of the question, not the previous one');
    t.ok(switched && PHRASES.en.includes(switched.text));
    const same = bridgeOf(await run({ enabled: true, toolMs: 300, language: 'ru', transcript: ['Расскажи', ' про лучшие винодельни'] }));
    t.equal(same && same.language, 'ru', 'same language: bridge unchanged');
    const unclear = bridgeOf(await run({ enabled: true, toolMs: 300, language: 'ro', transcript: ['ok'] }));
    t.equal(unclear && unclear.language, 'ro', 'unclear question: conversation language');

    const fast = types(await run({ enabled: true, toolMs: 10 }));
    t.ok(!fast.includes('assistant.bridge'), 'fast tool call: no bridge');
    t.ok(fast.includes('audio.end'));

    const off = types(await run({ enabled: false, toolMs: 300 }));
    t.ok(!off.includes('assistant.bridge'), 'flag off: no bridge, turn unchanged');
    t.ok(off.includes('audio.end'));

    const grok = types(await run({ enabled: true, toolMs: 300, provider: 'grok' }));
    t.ok(!grok.includes('assistant.bridge'), 'non-Gemini provider: no bridge');
}

// Client contract (public/dashboard.html): the phrase is finished, never cut
// mid-word by the answer -- the answer is queued after it -- while barge-in,
// stop and disconnect still cut it at once.
function clientContract() {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    const caseBody = (name) => {
        const start = html.indexOf(`case '${name}':`);
        return html.slice(start, html.indexOf("\n      case '", start + 1));
    };
    t.ok(!/stopBridge/.test(caseBody('audio.start')), 'answer start does not cut the bridge');
    t.ok(/playbackQueueTime = audioContext \? Math\.max\(audioContext\.currentTime, bridgeQueueFloor\(\)\)/.test(caseBody('audio.start')), 'answer is queued after the bridge');
    t.ok(!/stopBridge/.test(caseBody('audio.chunk')) && /bridgeQueueFloor\(\)/.test(caseBody('audio.chunk')), 'answer chunks never start before the bridge ends');
    t.ok(/function bridgeQueueFloor\(\) \{\s*return bridgeSource && bridgeEndsAt \? bridgeEndsAt \+ BRIDGE_TO_ANSWER_GAP_S : 0;/.test(html), 'floor = end of the phrase + short pause, 0 without a bridge');
    t.ok(/function triggerLocalBargeIn[\s\S]{0,80}stopBridge\('local_vad_barge_in'\)/.test(html), 'user speech cuts the bridge at once');
    t.ok(/function stopPlaybackImmediately[\s\S]{0,80}stopBridge\(/.test(html), 'playback stop cuts the bridge');
    t.ok(/function disconnect\(\) \{\s*stopBridge\('disconnect'\)/.test(html), 'disconnect cuts the bridge');
    t.ok(/function stopBridge[\s\S]{0,160}bridgeEndsAt = 0;/.test(html), 'a cut bridge no longer delays the answer');
}

// Production 30 Sep: after three deploys in half an hour the new process
// rendered none of the phrases (TTS rate limit), so no bridge played. Audio
// rendered once is persisted and a later process ("redeploy") plays it even
// when TTS is down.
async function persistence() {
    const { phraseKey, isPostgresUrl, createPostgresBridgePhraseStore } = require('../src/realtime/bridgePhraseStore');
    const rows = new Map();
    const store = {
        loads: 0,
        async load(voice) { this.loads += 1; return new Map([...rows].filter(([k]) => k.startsWith(`bridge_phrase:${voice}:`))); },
        async save(k, entry) { rows.set(k, entry); },
    };
    const total = PHRASES.ru.length + PHRASES.ro.length + PHRASES.en.length;

    let firstCalls = 0;
    const first = createBridgeAudioCache({ store, sleep: async () => {}, synthesize: async ({ text }) => { firstCalls += 1; return { audioBase64: Buffer.from(text).toString('base64'), sampleRate: 24000 }; } });
    await first.warm('Leda');
    t.equal(firstCalls, total, 'first process renders every phrase once');
    t.equal(rows.size, total, 'every rendered phrase is persisted');

    let ttsCalls = 0;
    const logs = [];
    const redeployed = createBridgeAudioCache({ store, sleep: async () => {}, log: (stage, extra) => logs.push({ stage, ...extra }), synthesize: async () => { ttsCalls += 1; throw new Error('429 rate limit'); } });
    await redeployed.warm('Leda');
    t.equal(ttsCalls, 0, 'redeploy: no TTS call when every phrase is stored');
    t.equal(redeployed.size(), total, 'redeploy: all phrases loaded from the store');
    t.equal(redeployed.status().loaded_from_store, total);
    t.equal(redeployed.status().persistent, true);
    const sent = [];
    const s = createBridgeScheduler({ config: { enabled: true, delayMs: 5, minTurnGap: 1 }, cache: redeployed, emit: (e) => sent.push(e), getVoice: () => 'Leda', getLanguage: () => 'ru' });
    s.onToolCall({ generationId: 'g1', turnId: 't1', turnNumber: 1 });
    await sleep(30);
    t.equal(sent.length, 1, 'redeploy with TTS down: the bridge still plays');
    t.equal(Buffer.from(sent[0].audio_base64, 'base64').toString(), sent[0].text, 'the stored audio belongs to the phrase text');

    // Edited phrase text -> different key -> old audio is never reused.
    t.ok(phraseKey('Leda', 'ru', 0, 'A') !== phraseKey('Leda', 'ru', 0, 'B'), 'key depends on the phrase text');
    rows.delete(phraseKey('Leda', 'en', 2, PHRASES.en[2]));
    let partialCalls = 0;
    const partial = createBridgeAudioCache({ store, sleep: async () => {}, synthesize: async () => { partialCalls += 1; return { audioBase64: 'AAAA' }; } });
    await partial.warm('Leda');
    t.equal(partialCalls, 1, 'only the phrase missing from the store is rendered');
    t.equal(rows.size, total, 'and saved');

    const broken = createBridgeAudioCache({ store: { load: async () => { throw new Error('db down'); }, save: async () => { throw new Error('db down'); } }, sleep: async () => {}, log: (stage, extra) => logs.push({ stage, ...extra }), synthesize: async () => ({ audioBase64: 'AAAA' }) });
    await broken.warm('Kore');
    t.equal(broken.size(), total, 'store errors fall back to TTS');
    t.ok(logs.some((l) => l.stage === 'bridge_phrase_store_failed'), 'store errors are logged');

    t.equal(createPostgresBridgePhraseStore({ env: { DATABASE_URL: 'memory' } }), null, 'no real database: no store');

    // Every persona voice (male Charon, female Kore, the Live Test voice)
    // gets its phrases before its first question, one voice after another.
    const { prewarmVoices } = require('../src/realtime/bridgePhrases');
    const order = [];
    let active = 0;
    let maxActive = 0;
    const multi = createBridgeAudioCache({ sleep: async () => {}, synthesize: async ({ voiceName }) => { active += 1; maxActive = Math.max(maxActive, active); order.push(voiceName); await sleep(1); active -= 1; return { audioBase64: 'AAAA' }; } });
    await prewarmVoices(multi, ['Charon', 'Kore', 'Leda', 'Kore', null]);
    t.equal(multi.status().rendered.Charon, total, 'male voice ready');
    t.equal(multi.status().rendered.Kore, total, 'female voice ready');
    t.equal(multi.status().rendered.Leda, total, 'Live Test voice ready');
    t.equal(maxActive, 1, 'one TTS call at a time, no burst');
    t.equal(order.length, 3 * total, 'duplicates and empty voices skipped');
    t.equal(multi.get('Charon', 'ru', 0) !== null && multi.get('Kore', 'ro', 1) !== null, true, 'each voice has every language');
    await prewarmVoices(null, ['Charon']);
    t.ok(isPostgresUrl('postgresql://u:p@h:5432/db') && isPostgresUrl('postgres://h/db'));
}

async function run() {
    clientContract();
    await unit();
    await persistence();
    await endToEnd();
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('bridgePhrases tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

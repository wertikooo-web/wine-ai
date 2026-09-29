'use strict';

// Bridge phrases ("Секунду…") while a knowledge search keeps the assistant
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
        const cache = createBridgeAudioCache({
            synthesize: async ({ text }) => { calls += 1; if (text === PHRASES.en[1]) throw new Error('tts down'); return { audioBase64: 'AAAA', sampleRate: 24000 }; },
        });
        await Promise.all([cache.warm('Kore'), cache.warm('Kore')]);
        const total = PHRASES.ru.length + PHRASES.ro.length + PHRASES.en.length;
        t.equal(calls, total, 'each phrase rendered once per voice (concurrent warm deduplicated)');
        t.equal(cache.size(), total - 1, 'a failed render is skipped, the rest are cached');
        t.equal(cache.get('Kore', 'en', 1), null);
        t.ok(cache.get('Kore', 'ru', 0));
    }
}

async function endToEnd() {
    const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
    const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
    const run = async ({ enabled, toolMs, provider = 'gemini' }) => {
        const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 5, chunkCount: 1, chunkIntervalMs: 5 });
        const server = http.createServer((req, res) => res.end());
        attachRealtimeServer(server, {
            providerMetadata: { provider, model: 'm', contentToolsEnabled: false, defaultVoiceName: 'Kore' },
            providerFactory: (options) => {
                const session = mock.createSession(options);
                session.voiceName = 'Kore';
                const endInput = session.endInput.bind(session);
                session.endInput = async (ctx) => {
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
            client.sendJson({ type: 'session.start', sampleRate: 16000 });
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

async function run() {
    clientContract();
    await unit();
    await endToEnd();
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('bridgePhrases tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

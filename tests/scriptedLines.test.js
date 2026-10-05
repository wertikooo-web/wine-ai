'use strict';

// Pre-rendered service lines (src/realtime/scriptedLines.js): the client
// asks for the 30-second warning / session end / inactivity lines and gets
// audio in the persona's voice instead of asking the model to say them
// (prod 2026-10-05: the model's warning was cut twice and the closing line
// never came). Server side: cache over its own phrase set, request ->
// assistant.scripted_line with text and audio; null audio when the voice is
// not a Gemini voice or not rendered yet (client falls back).

const http = require('http');
const t = require('./helpers/assertions');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { createBridgeAudioCache } = require('../src/realtime/bridgePhrases');
const scripted = require('../src/realtime/scriptedLines');
const { connect } = require('./helpers/wsTestClient');

async function session({ provider, cache }) {
    const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 5, chunkCount: 1, chunkIntervalMs: 5 });
    const server = http.createServer((req, res) => res.end());
    attachRealtimeServer(server, {
        providerMetadata: { provider, model: 'm', contentToolsEnabled: false, defaultVoiceName: 'Kore' },
        providerFactory: (options) => { const s = mock.createSession(options); s.voiceName = 'Kore'; return s; },
        bridgeConfig: { enabled: false, delayMs: 80, minTurnGap: 1 },
        scriptedCache: cache,
    });
    await new Promise((r) => server.listen(0, r));
    const client = await connect(server.address().port);
    await client.waitFor((e) => e.type === 'session.ready');
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied');
    return { client, done: () => { client.close(); server.closeAllConnections?.(); server.close(); } };
}

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };

    ok(scripted.lookup('session_limit', 'ro').text === scripted.LINES.ro[1] && scripted.lookup('session_warning', 'xx').lang === 'ru' && scripted.lookup('nope', 'ru') === null, 'lookup by key and language');

    const rendered = [];
    const cache = createBridgeAudioCache({
        synthesize: async ({ voiceName, text }) => { rendered.push(`${voiceName}:${text}`); return { audioBase64: Buffer.from(text).toString('base64'), sampleRate: 24000 }; },
        phrases: scripted.LINES,
        label: 'scripted',
        renderGapMs: 0,
    });
    await cache.warm('Kore');
    ok(rendered.length === 12 && rendered.some((r) => r.includes('Мне пора немного отдохнуть')), `all 12 service lines rendered once (${rendered.length})`);

    const g = await session({ provider: 'gemini', cache });
    try {
        g.client.sendJson({ type: 'scripted_line.request', key: 'session_limit', lang: 'ro', request_id: 'r1' });
        const e = await g.client.waitFor((x) => x.type === 'assistant.scripted_line', { timeoutMs: 3000 });
        ok(e.key === 'session_limit' && e.lang === 'ro' && e.text === scripted.LINES.ro[1] && e.request_id === 'r1', 'reply: key, language, exact text');
        ok(Buffer.from(e.audio_base64, 'base64').toString() === scripted.LINES.ro[1] && e.sample_rate === 24000, 'reply carries the rendered audio');
    } finally { g.done(); }

    const m = await session({ provider: 'grok', cache });
    try {
        m.client.sendJson({ type: 'scripted_line.request', key: 'session_warning', lang: 'ru' });
        const e = await m.client.waitFor((x) => x.type === 'assistant.scripted_line', { timeoutMs: 3000 });
        ok(e.audio_base64 === null && e.text === scripted.LINES.ru[0], 'non-Gemini voice: no audio, client falls back to the model');
    } finally { m.done(); }

    ok(scripted.enabled({}) === true && scripted.enabled({ SCRIPTED_LINES_AUDIO: 'off' }) === false, 'switch');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`scriptedLines passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

'use strict';

// Production 2026-09-29 (/lite, Gemini, Free Conversation): the user asked
// about a winery, heard the bridge phrase ("Минуточку, сейчас посмотрю."),
// then nothing. The knowledge/web tool took >10s; the input-hang watchdog
// (FREE_CONV_INPUT_HANG_TIMEOUT_MS, 12s since the last loud frame) saw a
// still-open input turn and cancelled the generation mid-tool, so the late
// tool result was dropped as stale. A tool call means the model already took
// the question as finished: the watchdog must not fire while a tool runs.
// A tool that never returns stays bounded by PTT_TOOL_TURN_TIMEOUT_MS.

process.env.NO_SPEECH_MIN_LOUD_MS = '0';
process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '150';
process.env.PTT_TOOL_TURN_TIMEOUT_MS = '1200';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('../src/realtime/mockRealtimeProvider');
const { connect } = require('./helpers/wsTestClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loudFrame(bytes = 4096) {
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(3000, i);
    return buf;
}

// Mock provider that, like Gemini in Free Conversation, answers while the
// input turn is still open: tool.call -> (toolMs) -> tool.response -> audio.
async function startServer({ toolMs, toolNeverReturns = false }) {
    const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 20, chunkIntervalMs: 20, chunkCount: 2 });
    const server = http.createServer((req, res) => res.end());
    attachRealtimeServer(server, {
        providerFactory: (options) => {
            const session = mock.createSession(options);
            session.beginResponse = (ctx) => {
                if (ctx.turnId === 'turn1') return;
                (async () => {
                    await sleep(30);
                    if (ctx.signal.cancelled) return;
                    ctx.onEvent({ type: 'tool.call', response_id: ctx.responseId, turn_id: ctx.turnId, tool_name: 'search_wine_knowledge' });
                    if (toolNeverReturns) return;
                    await sleep(toolMs);
                    if (ctx.signal.cancelled) return; // what production did: result dropped as stale
                    ctx.onEvent({ type: 'tool.response', response_id: ctx.responseId, turn_id: ctx.turnId, tool_names: ['search_wine_knowledge'] });
                    await session.endInput(ctx);
                })();
            };
            return session;
        },
    });
    await new Promise((r) => server.listen(0, r));
    return {
        port: server.address().port,
        close: async () => { server.closeAllConnections?.(); server.close(); },
    };
}

async function openFreeConversation(port) {
    const client = await connect(port);
    await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });
    client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', turn_id: 'turn1', micEchoCancellation: true, micTrackId: 'track-1' });
    await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn1)' });
    client.sendBinary(loudFrame());
    client.sendJson({ type: 'input_audio.end' });
    await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end (turn1)', timeoutMs: 5000 });
    return client;
}

test('Free Conversation: a tool call longer than the input-hang window is answered, not cancelled', async () => {
    const { port, close } = await startServer({ toolMs: 600 }); // 4x the 150ms hang window
    try {
        const client = await openFreeConversation(port);
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn2 = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)', timeoutMs: 2000 });
        client.sendBinary(loudFrame()); // the question; input_audio.end never comes (Free Conversation)
        const seen = [];
        await client.waitFor((e) => {
            if (e.turn_id === turn2.turn_id) seen.push(e.type);
            return e.turn_id === turn2.turn_id && ['audio.end', 'response.cancelled', 'response.failed'].includes(e.type);
        }, { label: 'turn2 outcome', timeoutMs: 4000 });
        assert.ok(!seen.includes('response.cancelled'), `the answer must not be cancelled during the tool call (saw ${seen.join(',')})`);
        assert.ok(seen.includes('tool.call') && seen.includes('tool.response'), 'tool ran to completion');
        assert.ok(seen.includes('audio.start') && seen.includes('audio.end'), 'the answer after the tool is delivered');
        client.close();
    } finally {
        await close();
    }
});

test('Free Conversation: a tool that never returns is still bounded (tool timeout), and the session accepts the next question', async () => {
    const { port, close } = await startServer({ toolNeverReturns: true });
    try {
        const client = await openFreeConversation(port);
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn2 = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)', timeoutMs: 2000 });
        client.sendBinary(loudFrame());
        const outcome = await client.waitFor(
            (e) => e.turn_id === turn2.turn_id && ['response.failed', 'response.cancelled', 'audio.end'].includes(e.type),
            { label: 'turn2 bounded outcome', timeoutMs: 4000 },
        );
        assert.equal(outcome.type, 'response.failed', 'a hung tool ends the turn via the tool timeout, not the input-hang watchdog');
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn3 = await client.waitFor((e) => e.type === 'input_audio.start' && e.turn_id !== turn2.turn_id, { label: 'input_audio.start (turn3)', timeoutMs: 3000 });
        assert.ok(turn3.turn_id, 'the session is not stuck');
        client.close();
    } finally {
        await close();
    }
});

// Server-side backstop for the /lite session limit (production 29 Sep: the
// client's closing line never played and the conversation went on past
// 0:00). Only the public lite channel is closed by the server.
test('server backstop: a /lite Free Conversation past limit + grace is ended and closed; the operator channel is not', async () => {
    const prevGrace = process.env.FREE_CONV_SERVER_LIMIT_GRACE_MS;
    process.env.FREE_CONV_SERVER_LIMIT_GRACE_MS = '100';
    const mock = new MockRealtimeProvider({ ...DEFAULT_CONFIG, processingDelayMs: 20, chunkIntervalMs: 20, chunkCount: 1 });
    const server = http.createServer((req, res) => res.end());
    attachRealtimeServer(server, {
        providerFactory: (options) => mock.createSession(options),
        getSessionLimitMs: () => 300,
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const run = async (path) => {
        const client = await connect(port, path);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });
        client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', turn_id: 'turn1', micEchoCancellation: true, micTrackId: 'track-1' });
        await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start' });
        let ended = null;
        try { ended = await client.waitFor((e) => e.type === 'session.ended', { label: 'session.ended', timeoutMs: 1500 }); } catch { /* none */ }
        return { client, ended };
    };
    try {
        const lite = await run('/realtime?channel=lite');
        assert.ok(lite.ended, 'lite session gets session.ended from the server backstop');
        assert.equal(lite.ended.reason, 'session_limit');
        lite.client.close();

        const op = await run('/realtime');
        assert.equal(op.ended, null, 'the operator (dashboard) channel is not ended by the backstop');
        op.client.close();
    } finally {
        if (prevGrace === undefined) delete process.env.FREE_CONV_SERVER_LIMIT_GRACE_MS; else process.env.FREE_CONV_SERVER_LIMIT_GRACE_MS = prevGrace;
        server.closeAllConnections?.();
        server.close();
    }
});

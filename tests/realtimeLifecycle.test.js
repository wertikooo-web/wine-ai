'use strict';

const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');
const t = require('./helpers/assertions');

function silenceFrame(samples = 160) {
    return Buffer.alloc(samples * 2);
}

async function runFullTurn() {
    const { port, close } = await startTestServer();
    try {
        const client = await connect(port);
        const ready = await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        t.ok(ready.session_id, 'session.ready must carry a session_id');
        const sessionId = ready.session_id;

        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        const startEvent = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start echo' });
        const turnId = startEvent.turn_id;
        const generationId = startEvent.generation_id;
        t.ok(turnId && generationId, 'input_audio.start must carry turn_id and generation_id');

        client.sendBinary(silenceFrame());
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor((e) => e.type === 'input_audio.end', { label: 'input_audio.end echo' });

        const created = await client.waitFor((e) => e.type === 'response.created', { label: 'response.created' });
        t.equal(created.turn_id, turnId, 'response.created must correlate to the same turn_id');
        t.equal(created.generation_id, generationId, 'response.created must correlate to the same generation_id');

        const audioStart = await client.waitFor((e) => e.type === 'audio.start', { label: 'audio.start' });
        t.equal(audioStart.generation_id, generationId);

        const firstChunk = await client.waitFor((e) => e.type === 'audio.chunk', { label: 'first audio.chunk' });
        t.equal(firstChunk.generation_id, generationId);
        t.ok(firstChunk.audio_base64, 'audio.chunk must carry base64 audio payload');

        const audioEnd = await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end', timeoutMs: 6000 });
        t.equal(audioEnd.generation_id, generationId, 'audio.end must correlate to the same generation as the rest of the turn');
        t.equal(audioEnd.session_id, sessionId, 'every event in the turn must carry the same session_id');

        client.close();
    } finally {
        await close();
    }
}

async function runInterruptAndBargeIn() {
    // Long processing delay so there is a real window to interrupt mid-turn.
    const { port, close } = await startTestServer({ mockConfig: { processingDelayMs: 2000, chunkCount: 20, chunkIntervalMs: 150 } });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        const start1 = await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(silenceFrame());
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor((e) => e.type === 'input_audio.end');

        // Interrupt well before the mock provider's 2s processing delay
        // elapses — this must produce response.cancelled, not a late
        // response.created for the cancelled generation.
        client.sendJson({ type: 'session.interrupt', reason: 'manual_stop' });
        const cancelled = await client.waitFor((e) => e.type === 'response.cancelled', { label: 'response.cancelled' });
        t.equal(cancelled.generation_id, start1.generation_id);
        t.ok(typeof cancelled.cancel_latency_ms === 'number', 'response.cancelled must report cancel_latency_ms');

        // Barge-in: starting a new turn immediately must not surface any
        // stray event from the cancelled generation. AGENTS.md requires
        // this idempotency explicitly ("New child input must never enter a
        // provider session already considered closed or invalid" — adapted
        // here to the wine-domain session).
        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        const start2 = await client.waitFor((e) => e.type === 'input_audio.start');
        t.ok(start2.generation_id !== start1.generation_id, 'barge-in must produce a fresh generation_id, never reuse the cancelled one');
        t.ok(start2.turn_id !== start1.turn_id, 'barge-in must produce a fresh turn_id');

        client.close();
    } finally {
        await close();
    }
}

async function runStaleFrameDropped() {
    const { port, close } = await startTestServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor((e) => e.type === 'input_audio.end');

        // A binary frame arriving after input_audio.end (before any new
        // input_audio.start) is exactly the "late data for a closed input"
        // case AGENTS.md calls out — the server's onBinary guard
        // (`!currentGeneration || !inputStartedAt || inputEndedAt`) must
        // silently drop it rather than attribute it to a future turn or
        // crash the session. There is no client-visible event for a drop
        // (by design — it's a no-op), so this test's assertion is simply
        // that the session stays healthy and ping/pong still works right
        // after sending it.
        client.sendBinary(silenceFrame());
        client.sendJson({ type: 'ping', timestamp_ms: Date.now() });
        const pong = await client.waitFor((e) => e.type === 'pong', { label: 'pong after stray late frame' });
        t.ok(pong, 'session must remain healthy after a late/stray binary frame');

        client.close();
    } finally {
        await close();
    }
}

async function runReconnectIsolation() {
    const { port, close } = await startTestServer();
    try {
        const clientA = await connect(port);
        const readyA = await clientA.waitFor((e) => e.type === 'session.ready');

        const clientB = await connect(port);
        const readyB = await clientB.waitFor((e) => e.type === 'session.ready');

        t.ok(readyA.session_id !== readyB.session_id, 'each new connection must get its own session_id — no server-side session resumption in v1 (see docs/ARCHITECTURE.md)');

        clientA.close();
        clientB.close();
    } finally {
        await close();
    }
}

async function run() {
    await runFullTurn();
    await runInterruptAndBargeIn();
    await runStaleFrameDropped();
    await runReconnectIsolation();
}

module.exports = { run };

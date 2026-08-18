'use strict';

// Regression coverage for the 2026-08-18 staging release-gate finding: a
// real barge-in in Free Conversation (handleNativeSpeechStarted()) cancelled
// the active generation, but on a rotateOnInterrupt provider (Grok) never
// actually rotated to a fresh provider instance. The OLD instance was
// already draining (interrupt() sent response.cancel/input_audio_buffer.clear
// and flipped its lifecycleState), yet `providerSession` kept pointing at it
// for the entire new turn -- its audio piled up in the local replay buffer
// with nowhere live to go until the unrelated 12s input_hang_timeout
// fallback finally rotated. Root cause: handleNativeSpeechStarted() called
// cancelCurrent() itself, then startInput() called ITS OWN cancelCurrent(),
// which is idempotent and returns false once already-cancelled -- so
// startInput()'s "cancelled -> rotate" gate never fired for this path.
//
// Fix: handleNativeSpeechStarted() now captures its OWN cancelCurrent()
// return value and rotates immediately when appropriate, before startInput()
// ever runs.
//
// Real HTTP+WS server + mock provider (rotateOnInterrupt configurable),
// same harness as tests/voiceModeTurnDetection.test.js.

process.env.NO_SPEECH_MIN_LOUD_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

function loudFrame(bytes = 4096) {
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(3000, i);
    return buf;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openTapToStartSession(port) {
    const client = await connect(port);
    await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });
    return client;
}

// Establishes an active, currently-streaming response (mirrors the real
// incident's "assistant is speaking" state) via a real client tap.
async function establishActiveResponse(client, turnId = 'turn1') {
    client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', turn_id: turnId, micEchoCancellation: true, micTrackId: 'mic-1' });
    await client.waitFor((e) => e.type === 'input_audio.start');
    client.sendBinary(loudFrame());
    client.sendJson({ type: 'input_audio.end' });
    const audioStart = await client.waitFor((e) => e.type === 'audio.start', { label: 'audio.start', timeoutMs: 5000 });
    return audioStart;
}

test('Free Conversation + rotateOnInterrupt provider (Grok-shaped): barge-in rotates to a fresh instance BEFORE the new turn streams audio, and gets a real response (not the 12s fallback)', async () => {
    const { port, close, provider } = await startTestServer({
        mockConfig: { rotateOnInterrupt: true, processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 3 },
    });
    // Short window so a false-negative (fix broken, falls back to the
    // watchdog) is caught fast instead of the test hanging ~12s.
    process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '2000';
    try {
        const client = await openTapToStartSession(port);
        const turn1Response = await establishActiveResponse(client, 'turn1');
        assert.equal(provider.sessions.length, 2, 'setup: session.start + turn1 should have used 2 provider instances so far (initial connect, then per-turn/session rotation as configured)');
        const oldInstanceCountBeforeBargeIn = provider.sessions.length;

        // Genuine barge-in: confirmed local VAD signal.
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const cancelled = await client.waitFor((e) => e.type === 'response.cancelled' && e.turn_id === turn1Response.turn_id, { label: 'response.cancelled', timeoutMs: 2000 });
        assert.equal(cancelled.reason, 'native_speech_started');

        // 1. Old provider goes into draining (mock: interrupt() flips its
        // activeSignal; the important, testable fact is that it must not
        // receive the new turn's audio -- checked below).
        const oldSession = provider.sessions[oldInstanceCountBeforeBargeIn - 1];
        const oldInputBytesAtCancel = oldSession.inputBytes;

        // 2. A NEW provider instance must exist immediately, with the
        // correct rotation reason -- not lazily, not only after a fallback.
        assert.equal(provider.sessions.length, oldInstanceCountBeforeBargeIn + 1, 'exactly one new provider instance must be created immediately after the barge-in, before the new turn opens');
        const newSession = provider.sessions[provider.sessions.length - 1];
        assert.equal(newSession.rotationReason, 'native_speech_started', 'the new instance must be tagged with the actual rotation cause');

        // 3. turn2 opens (the barge-in's own new turn).
        const turn2Start = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)', timeoutMs: 2000 });
        assert.notEqual(turn2Start.turn_id, turn1Response.turn_id);

        // 4. turn2 gets a REAL response quickly -- via the normal path, not
        // the 12s input_hang_timeout fallback.
        client.sendBinary(loudFrame());
        client.sendJson({ type: 'input_audio.end' });
        const turn2AudioStart = await client.waitFor((e) => e.type === 'audio.start' && e.turn_id === turn2Start.turn_id, { label: 'audio.start (turn2, real response)', timeoutMs: 3000 });
        assert.ok(turn2AudioStart, 'turn2 must reach a real audio.start well within the input-hang window');

        // 5. input_hang_timeout must NOT have fired for turn2.
        const unsolicited = [];
        for (;;) {
            try { unsolicited.push(await client.nextEvent(200)); } catch { break; }
        }
        assert.ok(!unsolicited.some((e) => e.type === 'response.cancelled' && e.reason === 'input_hang_timeout'), 'turn2 must not be recovered via the input_hang_timeout fallback -- it must get a real response directly');

        // 6. The OLD (draining) provider must never have received turn2's audio.
        assert.equal(oldSession.inputBytes, oldInputBytesAtCancel, 'the old, draining provider instance must not receive any audio from the new turn');

        client.close();
    } finally {
        delete process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS;
        await close();
    }
});

test('Free Conversation + non-rotating provider (Gemini/Classic-shaped, rotateOnInterrupt:false): barge-in does NOT trigger an extra rotation', async () => {
    const { port, close, provider } = await startTestServer({
        mockConfig: { rotateOnInterrupt: false, processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 3 },
    });
    // Not exercising the hang-timeout here -- keep the leftover open turn2
    // from waiting out the real 12s default.
    process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '500';
    try {
        const client = await openTapToStartSession(port);
        const turn1Response = await establishActiveResponse(client, 'turn1');
        const sessionCountBeforeBargeIn = provider.sessions.length;

        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const cancelled = await client.waitFor((e) => e.type === 'response.cancelled' && e.turn_id === turn1Response.turn_id, { label: 'response.cancelled', timeoutMs: 2000 });
        assert.equal(cancelled.reason, 'native_speech_started');

        await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)', timeoutMs: 2000 });

        assert.equal(provider.sessions.length, sessionCountBeforeBargeIn, 'a non-rotating provider (Gemini tap_to_start / Classic) must NOT get an extra provider instance from this fix -- shouldRotateProviderOnInterrupt() must stay false for it');

        client.close();
    } finally {
        delete process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS;
        await close();
    }
});

test('Free Conversation + rotateOnInterrupt provider: five repeated barge-ins create exactly five new instances, never two for one interrupt', async () => {
    const { port, close, provider } = await startTestServer({
        mockConfig: { rotateOnInterrupt: true, processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 2 },
    });
    process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '2000';
    try {
        const client = await openTapToStartSession(port);
        let lastTurn = (await establishActiveResponse(client, 'turn0')).turn_id;

        for (let i = 1; i <= 5; i += 1) {
            const countBefore = provider.sessions.length;
            client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
            await client.waitFor((e) => e.type === 'response.cancelled' && e.reason === 'native_speech_started', { label: `cancel #${i}`, timeoutMs: 2000 });
            assert.equal(provider.sessions.length, countBefore + 1, `interrupt #${i} must create exactly one new provider instance, never zero or two`);

            const newTurn = await client.waitFor((e) => e.type === 'input_audio.start', { label: `new turn #${i}`, timeoutMs: 2000 });
            assert.notEqual(newTurn.turn_id, lastTurn);
            client.sendBinary(loudFrame());
            client.sendJson({ type: 'input_audio.end' });
            const audioStart = await client.waitFor((e) => e.type === 'audio.start' && e.turn_id === newTurn.turn_id, { label: `audio.start #${i}`, timeoutMs: 3000 });
            lastTurn = audioStart.turn_id;
        }

        client.close();
    } finally {
        delete process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS;
        await close();
    }
});

test('Push-to-talk is untouched by this fix (handleNativeSpeechStarted only runs in tap_to_start mode)', async () => {
    const { port, close, provider } = await startTestServer({
        mockConfig: { rotateOnInterrupt: true, processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 2 },
    });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', turn_id: 'turn1' });
        await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(loudFrame());
        client.sendJson({ type: 'input_audio.end' });
        await client.waitFor((e) => e.type === 'audio.start', { timeoutMs: 5000 });

        // A stray native-speech signal must be a no-op in push_to_talk --
        // handleNativeSpeechStarted() early-returns before ever touching
        // cancelCurrent()/rotateProviderSession().
        const sessionCountBefore = provider.sessions.length;
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        await sleep(200);
        const unsolicited = [];
        for (;;) {
            try { unsolicited.push(await client.nextEvent(150)); } catch { break; }
        }
        assert.ok(!unsolicited.some((e) => e.type === 'response.cancelled'), 'push_to_talk must not be interrupted by a native-speech signal');
        assert.equal(provider.sessions.length, sessionCountBefore, 'push_to_talk must not rotate the provider from a stray native-speech signal');

        client.close();
    } finally {
        await close();
    }
});

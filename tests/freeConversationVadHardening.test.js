'use strict';

// Regression coverage for the 2026-08-17 production incident
// (session_a27050c285b85de6, 18:02 UTC): a short loud non-speech transient
// fired a false local-VAD barge-in, a second false trigger then cancelled
// the NEXT response right as it started, and the turn opened for that
// cancellation never received input_audio.end -- the session got stuck
// ignoring all further speech. The client-side debounce fix
// (LOCAL_VAD_CONFIRM_FRAMES) is covered in tests/dashboardBargeIn.test.js;
// this file covers the two server-side hardening pieces in
// src/realtime/realtimeServer.js:
//   1. FREE_CONV_INPUT_HANG_TIMEOUT_MS -- a VAD-opened turn that never ends
//      is force-closed so the session recovers instead of hanging forever.
//   2. handleNativeSpeechStarted()'s explicit decision logging
//      (accepted / ignored_duplicate_user_input / ignored_unconfirmed_mic)
//      replacing silent returns.
// Real HTTP+WS server, mock provider, no timers faked -- same harness as
// tests/voiceModeTurnDetection.test.js / tests/grokProviderIsolation.test.js.

process.env.NO_SPEECH_MIN_LOUD_MS = '0';
// Short window so these tests run fast and deterministically.
process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '150';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

function loudFrame(bytes = 4096) {
    // Matches the amplitude the server's own no-speech gate treats as real
    // audio -- content doesn't matter for these tests (NO_SPEECH_MIN_LOUD_MS
    // is disabled above), only that it's a normal-shaped PCM16 frame.
    const buf = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 2) buf.writeInt16LE(3000, i);
    return buf;
}

function captureLogs() {
    const lines = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    return {
        lines,
        restore() { console.log = original; },
    };
}

async function openTapToStartSession(port) {
    const client = await connect(port);
    await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
    client.sendJson({ type: 'session.start', sampleRate: 16000 });
    await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });
    return client;
}

// Turn 1 is always the client's own real input_audio.start (the tap) --
// this is what sets micPipelineConfirmed=true, required for every later
// handleNativeSpeechStarted() call to actually open a turn.
async function completeFirstTurn(client) {
    client.sendJson({
        type: 'input_audio.start',
        mode: 'tap_to_start',
        turn_id: 'turn1',
        micEchoCancellation: true,
        micTrackId: 'track-1',
    });
    await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn1)' });
    client.sendBinary(loudFrame());
    client.sendJson({ type: 'input_audio.end' });
    await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end (turn1)', timeoutMs: 5000 });
}

test('Free Conversation: a VAD-opened turn that never ends is force-closed by the input-hang timeout, and the session recovers', async () => {
    const { port, close } = await startTestServer({ mockConfig: { processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 2 } });
    const logs = captureLogs();
    try {
        const client = await openTapToStartSession(port);
        await completeFirstTurn(client);

        // Simulate a confirmed local-VAD signal (client already debounced
        // it) with the assistant idle -- this is exactly the shape of the
        // incident's second false trigger: handleNativeSpeechStarted() cancels
        // nothing real and opens a fresh turn (turn2).
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn2Start = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)', timeoutMs: 2000 });
        assert.notEqual(turn2Start.turn_id, 'turn1', 'a genuinely new turn must have opened');

        // Deliberately never send input_audio.end for turn2 -- this is the
        // "lost stop signal" the incident exhibited. Without the fix this
        // hangs forever; with it, the hang timeout (150ms in this test)
        // force-cancels it.
        const cancelled = await client.waitFor(
            (e) => e.type === 'response.cancelled' && e.turn_id === turn2Start.turn_id,
            { label: 'response.cancelled (input_hang_timeout)', timeoutMs: 2000 },
        );
        assert.equal(cancelled.reason, 'input_hang_timeout', 'the hung turn must be recovered with the expected reason');
        assert.ok(logs.lines.some((l) => l.includes('input_hang_timeout')), 'the hang recovery must be logged server-side');

        // The session must not be stuck: the NEXT speech signal must open a
        // genuinely new turn (turn3), not be silently swallowed.
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn3Start = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn3)', timeoutMs: 2000 });
        assert.notEqual(turn3Start.turn_id, turn2Start.turn_id, 'the session must recover and accept the next real speech signal as a fresh turn');

        client.close();
    } finally {
        logs.restore();
        await close();
    }
});

test('Free Conversation: a genuine barge-in over an actively-streaming response is still accepted (logged decision=accepted, hadActiveResponse=true)', async () => {
    // Long chunk stream so there is a wide window where the response is
    // genuinely "active" (audio.start already sent, more chunks still coming).
    const { port, close } = await startTestServer({ mockConfig: { processingDelayMs: 20, chunkIntervalMs: 300, chunkCount: 6 } });
    const logs = captureLogs();
    try {
        const client = await openTapToStartSession(port);
        await completeFirstTurn(client);

        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const turn2Start = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn2)' });
        client.sendBinary(loudFrame());
        client.sendJson({ type: 'input_audio.end' });
        // Let the mock provider actually start streaming audio for turn2
        // before the barge-in -- this is what makes generation.status 'active'.
        await client.waitFor((e) => e.type === 'audio.start', { label: 'audio.start (turn2)', timeoutMs: 3000 });

        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        const cancelled = await client.waitFor(
            (e) => e.type === 'response.cancelled' && e.turn_id === turn2Start.turn_id,
            { label: 'response.cancelled (genuine barge-in)', timeoutMs: 2000 },
        );
        assert.equal(cancelled.reason, 'native_speech_started', 'a genuine mid-response barge-in must still cancel the active generation');

        const turn3Start = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn3)', timeoutMs: 2000 });
        assert.notEqual(turn3Start.turn_id, turn2Start.turn_id, 'the barge-in must open a fresh turn for the interrupting speech');

        assert.ok(
            logs.lines.some((l) => l.includes("decision=accepted") && l.includes('hadActiveResponse=true')),
            'a genuine barge-in over an active response must be logged as accepted with hadActiveResponse=true',
        );

        client.close();
    } finally {
        logs.restore();
        await close();
    }
});

test('Free Conversation: a duplicate speech signal for the SAME still-open utterance is explicitly logged and ignored, not silently dropped', async () => {
    const { port, close } = await startTestServer({ mockConfig: { processingDelayMs: 500, chunkIntervalMs: 100, chunkCount: 2 } });
    const logs = captureLogs();
    try {
        const client = await openTapToStartSession(port);

        // Open turn1 for real, but do NOT end it yet -- isTurnOpen() must
        // read true for the whole window between input_audio.start and
        // input_audio.end.
        client.sendJson({
            type: 'input_audio.start',
            mode: 'tap_to_start',
            turn_id: 'turn1',
            micEchoCancellation: true,
            micTrackId: 'track-1',
        });
        await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn1)' });

        // A duplicate native-speech signal for the SAME still-open utterance
        // (e.g. the provider's own VAD firing again mid-utterance) must be
        // ignored, not treated as a barge-in over itself.
        client.sendJson({ type: 'input_audio.speech_start', source: 'client_local_vad' });
        // Give the server a moment to process the (non-)event -- there is no
        // WS event to wait on for an intentional no-op, so this asserts on
        // the server log instead.
        await new Promise((resolve) => setTimeout(resolve, 100));

        assert.ok(
            logs.lines.some((l) => l.includes('ignored_duplicate_user_input')),
            'a duplicate signal for the same open utterance must be explicitly logged, not silently swallowed',
        );
        // And, critically, must NOT have opened a second turn or cancelled turn1.
        assert.ok(!logs.lines.some((l) => l.includes('stage=input_audio_start') && l.includes('turnCount=2')), 'no second turn must have opened from the duplicate signal');

        client.close();
    } finally {
        logs.restore();
        await close();
    }
});

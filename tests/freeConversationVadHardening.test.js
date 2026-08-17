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

// PR #69 review: FREE_CONV_INPUT_HANG_TIMEOUT_MS must be an INACTIVITY
// watchdog (reset by real progress), not an absolute cap on how long a
// user's turn may run -- a real 15-30s reply must complete normally.
// Proven here by continuously sending frames for a duration that is many
// times longer than the configured hang-timeout window (the test uses the
// same small 150ms window as the rest of this file, for speed -- the
// watchdog is re-armed on every frame with no special-casing by magnitude,
// so this generalizes directly to production's real 12000ms default: a
// real 15-30s reply sends far more than one frame every 12s, so it never
// goes 12s without progress either).
test('Free Conversation: a long turn with continuous frames is NOT cancelled by the input-hang watchdog, even though total duration far exceeds the configured window', async () => {
    const { port, close } = await startTestServer({ mockConfig: { processingDelayMs: 30, chunkIntervalMs: 20, chunkCount: 2 } });
    try {
        const client = await openTapToStartSession(port);

        client.sendJson({
            type: 'input_audio.start',
            mode: 'tap_to_start',
            turn_id: 'turn1',
            micEchoCancellation: true,
            micTrackId: 'track-1',
        });
        await client.waitFor((e) => e.type === 'input_audio.start', { label: 'input_audio.start (turn1)' });

        // Configured hang window in this file is 150ms. Send a frame every
        // 40ms (well inside the window, like a real continuous mic stream)
        // for 20 iterations = 800ms total -- over 5x the configured window,
        // proportionally equivalent to a real ~15s+ reply against
        // production's 12000ms default.
        const FRAME_INTERVAL_MS = 40;
        const FRAME_COUNT = 20;
        for (let i = 0; i < FRAME_COUNT; i += 1) {
            client.sendBinary(loudFrame());
            await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
        }

        // Scoped to THIS client's own WS session (not a global console.log
        // capture -- an earlier test's server can still be tearing down
        // asynchronously when this one starts, per testServer.js's own
        // "best-effort close" comment, and a global log-capture assertion
        // was found to intermittently pick up a stray leftover log line from
        // that unrelated prior session, a real bug in the TEST, not the
        // fix). Drain any events that arrived unsolicited during the send
        // loop above and confirm none of them is a response.cancelled for
        // this turn -- the watchdog firing is the ONLY thing that would
        // produce one before input_audio.end is even sent.
        const unsolicited = [];
        for (;;) {
            try { unsolicited.push(await client.nextEvent(50)); } catch { break; }
        }
        const prematureCancel = unsolicited.find((e) => e.type === 'response.cancelled' && e.turn_id === 'turn1');
        assert.equal(prematureCancel, undefined, 'continuous frames must keep re-arming the watchdog -- it must never fire while real progress keeps arriving');

        // The turn must still be open and completable via the normal path
        // (this is what a real provider-VAD end-of-speech looks like).
        client.sendJson({ type: 'input_audio.end' });
        const audioEnd = await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end (long turn)', timeoutMs: 3000 });
        assert.equal(audioEnd.turn_id, 'turn1', 'the long turn must complete normally and produce a real response, not get force-cancelled');

        client.close();
    } finally {
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
    // This test's own wait/drain window (below) can exceed the file's
    // shared 150ms hang-timeout window on a slow CI box, which would then
    // legitimately (but unintentionally) fire the OTHER fix under test here
    // and cancel turn1 out from under this assertion -- found via repeated
    // runs. Temporarily widen the watchdog for just this test; it's read
    // live from process.env on every arm, so this takes effect immediately
    // and is restored in `finally` so it never leaks into other tests.
    const previousHangTimeout = process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS;
    process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = '5000';
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
        // A real client keeps streaming audio frames the whole time a turn
        // is open -- without at least one, this test's own turn1 would sit
        // with input_audio.end never sent AND no frame ever re-arming the
        // input-hang watchdog (this file's shared 150ms window), so the
        // watchdog would legitimately fire and cancel turn1 out from under
        // this test (found via repeated runs: turn1 was correctly, but
        // unintentionally, cancelled here before the fix below).
        client.sendBinary(loudFrame());

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
        // And, critically, must NOT have opened a second turn or cancelled
        // turn1. Scoped to this client's own WS events (not the shared
        // console.log capture) -- an unrelated prior test's server can still
        // be finishing async teardown when this one starts (testServer.js's
        // own "best-effort close" comment), and a global-log-based negative
        // assertion here was found, on review, to carry the same
        // cross-test-leak risk that broke the long-turn test above.
        const unsolicited = [];
        for (;;) {
            try { unsolicited.push(await client.nextEvent(50)); } catch { break; }
        }
        assert.ok(!unsolicited.some((e) => e.type === 'input_audio.start'), 'no second turn must have opened from the duplicate signal');
        assert.ok(!unsolicited.some((e) => e.type === 'response.cancelled'), 'turn1 must not have been cancelled by the duplicate signal');

        client.close();
    } finally {
        logs.restore();
        await close();
        if (previousHangTimeout === undefined) delete process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS;
        else process.env.FREE_CONV_INPUT_HANG_TIMEOUT_MS = previousHangTimeout;
    }
});

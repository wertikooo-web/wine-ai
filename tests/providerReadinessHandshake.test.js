'use strict';

// Regression coverage for the "first PTT press doesn't hear, second one
// does" production symptom. Root cause chain:
//   1) provider connection used to be fully lazy — nothing called
//      providerSession.connect() until the first turn's beginResponse(),
//      so a PTT press right after session.start could race the still-
//      connecting provider.
//   2) the client had no explicit signal for "provider is actually ready
//      to receive audio" — it treated WebSocket OPEN as ready, which is
//      not the same thing.
// Fix: realtimeServer.js's session.start handler now eagerly awaits
// warmProviderSession('session_start_config'), which calls
// providerSession.connect() and emits a provider.ready event once it
// resolves. See public/dashboard.html's providerReadyForInput/
// pendingPttStart for the client-side half of this handshake.
// This file's frames are silent placeholder audio (Buffer.alloc), not real
// speech — the server's no-speech gate (realtimeServer.js's
// countLoudSamples/endInput) would otherwise cancel every turn here before
// it ever reaches the mock provider. Disabled for the readiness tests below;
// the dedicated no-speech gate tests further down re-enable it explicitly.
process.env.NO_SPEECH_MIN_LOUD_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

function loudFrame(samples = 320) {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
        // A simple full-scale square wave — clears any realistic amplitude
        // threshold without needing an FFT/real speech to prove the gate.
        buffer.writeInt16LE(i % 2 === 0 ? 16000 : -16000, i * 2);
    }
    return buffer;
}

test('provider.ready fires only after connect() resolves, even when connect is slow', async () => {
    const { port, close } = await startTestServer({ mockConfig: { connectDelayMs: 300 } });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });

        client.sendJson({ type: 'session.start' });

        const startedAt = Date.now();
        const readyEvent = await client.waitFor((e) => e.type === 'provider.ready', {
            label: 'provider.ready',
            timeoutMs: 3000,
        });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 250, `provider.ready fired too early (after ${elapsedMs}ms) — connect() delay was not actually awaited`);
        assert.equal(readyEvent.reason, 'session_start_config');
        client.close();
    } finally {
        await close();
    }
});

test('a PTT press issued before provider.ready is not lost — the turn still starts once ready', async () => {
    const { port, close } = await startTestServer({ mockConfig: { connectDelayMs: 300 } });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });

        client.sendJson({ type: 'session.start' });

        // Simulate the user pressing PTT immediately, before the server has
        // any chance to finish connecting the provider — this is exactly
        // the race that used to silently drop the first utterance.
        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        client.sendBinary(Buffer.alloc(320));

        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        client.sendJson({ type: 'input_audio.end' });

        // If the early audio frame was silently dropped instead of queued/
        // retried, no model output ever arrives and this times out.
        const audioStart = await client.waitFor((e) => e.type === 'audio.start', {
            label: 'audio.start (proves the early turn was not lost)',
            timeoutMs: 3000,
        });
        assert.ok(audioStart);
        client.close();
    } finally {
        await close();
    }
});

// No-speech gate: "audio bytes exist" must not be treated as proof of
// speech — a short press with only silence/room-noise must not reach the
// provider as a real turn. These two tests re-enable the real threshold
// (disabled at the top of this file for the readiness tests above).
test('a push_to_talk turn with only silence is cancelled as no_speech — zero model responses', async () => {
    const previousThreshold = process.env.NO_SPEECH_MIN_LOUD_MS;
    delete process.env.NO_SPEECH_MIN_LOUD_MS; // real default (200ms)
    try {
        const { port, close } = await startTestServer();
        try {
            const client = await connect(port);
            await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
            client.sendJson({ type: 'session.start' });
            await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

            client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix_test_silence' });
            client.sendBinary(Buffer.alloc(320)); // pure silence
            client.sendJson({ type: 'input_audio.end' });

            const noSpeechEvent = await client.waitFor((e) => e.type === 'input_audio.no_speech', {
                label: 'input_audio.no_speech',
                timeoutMs: 3000,
            });
            assert.ok(noSpeechEvent);

            // Prove no model response follows — if the gate failed silently
            // and let the turn through, the mock provider would still emit
            // audio.start shortly after.
            let sawAudioStart = false;
            try {
                await client.waitFor((e) => e.type === 'audio.start', { timeoutMs: 800 });
                sawAudioStart = true;
            } catch { /* expected: no audio.start ever arrives */ }
            assert.equal(sawAudioStart, false, 'no_speech turn must produce zero model responses');
            client.close();
        } finally {
            await close();
        }
    } finally {
        if (previousThreshold === undefined) delete process.env.NO_SPEECH_MIN_LOUD_MS;
        else process.env.NO_SPEECH_MIN_LOUD_MS = previousThreshold;
    }
});

test('a push_to_talk turn with real signal above the threshold still gets a normal response (no regression)', async () => {
    const previousThreshold = process.env.NO_SPEECH_MIN_LOUD_MS;
    delete process.env.NO_SPEECH_MIN_LOUD_MS; // real default (200ms)
    try {
        const { port, close } = await startTestServer();
        try {
            const client = await connect(port);
            await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
            client.sendJson({ type: 'session.start' });
            await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

            client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix_test_loud' });
            // 320 samples/frame @ 16kHz = 20ms/frame; need > 200ms of loud
            // audio to clear NO_SPEECH_MIN_LOUD_MS, so send comfortably more.
            for (let i = 0; i < 15; i += 1) client.sendBinary(loudFrame());
            client.sendJson({ type: 'input_audio.end' });

            const audioStart = await client.waitFor((e) => e.type === 'audio.start', {
                label: 'audio.start',
                timeoutMs: 3000,
            });
            assert.ok(audioStart);
            client.close();
        } finally {
            await close();
        }
    } finally {
        if (previousThreshold === undefined) delete process.env.NO_SPEECH_MIN_LOUD_MS;
        else process.env.NO_SPEECH_MIN_LOUD_MS = previousThreshold;
    }
});

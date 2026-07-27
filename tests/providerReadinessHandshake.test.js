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

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

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

// No-speech gate: ground truth is the provider's OWN transcription, not a
// local amplitude/duration guess (see realtimeServer.js's emitProviderEvent()
// comment on the 2026-07-27 false-positive incident this replaced). The mock
// provider emits a synthetic transcript.user by default (see
// mockRealtimeProvider.js's mockTranscript config) so ordinary tests are
// unaffected; these two tests override it directly to exercise both sides
// of the real gate.
test('a push_to_talk turn the provider transcribes as empty is cancelled as no_speech — zero model responses', async () => {
    const { port, close } = await startTestServer({ mockConfig: { mockTranscript: '' } });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start' });
        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix_test_silence' });
        client.sendBinary(Buffer.alloc(320)); // bytes exist, but the provider transcribes nothing
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
});

test('a push_to_talk turn the provider actually transcribes still gets a normal response, even with quiet/short audio (no false positive)', async () => {
    // Deliberately quiet AND short — this is exactly the shape of real
    // utterance (turnInputBytes=57344, loudMs=181 against the old 200ms
    // floor) that the amplitude-only gate wrongly rejected in production.
    const { port, close } = await startTestServer({ mockConfig: { mockTranscript: 'какое вино к ужину' } });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start' });
        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix_test_quiet_real' });
        client.sendBinary(Buffer.alloc(320)); // quiet/short on purpose — the provider transcribed it anyway
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
});

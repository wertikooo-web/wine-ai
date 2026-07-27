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

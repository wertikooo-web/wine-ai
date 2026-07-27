'use strict';

// Regression coverage for the alternating "не услышал -> услышал" PTT
// failure, root-caused via production logs (see realtimeServer.js's
// providerSessionUsedForTurn comment for the full chain):
//
//   In rotationMode=per_turn, geminiLiveProvider.js's rotateAfterOutputComplete
//   is hardcoded false for hold_to_talk (a deliberate, still-necessary choice
//   — see its own comment), so a turn that completes normally (audio.end)
//   never rotates the provider. If the next PTT press starts before/without
//   cancelCurrent() triggering the interrupt-rotation path either (the normal
//   case for two back-to-back but non-overlapping presses), the SAME
//   provider instance serves both turns. The adapter's `this.active` is a
//   single mutable slot with no id of its own on the raw provider message —
//   a late/duplicate completion signal genuinely meant for the OLD turn gets
//   attributed to whichever turn is `this.active` NOW, killing the NEW turn
//   with provider_turn_closed_during_input / provider_turn_closed_before_output
//   even though it never actually failed.
//
// Fix: startInput() now unconditionally rotates the provider before starting
// any turn whose predecessor already used the current instance
// (providerSessionUsedForTurn), independent of which path ended that
// predecessor. This closes the gap for every exit path, not just audio.end.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

async function runTurn(client, interactionId) {
    client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: interactionId });
    client.sendBinary(Buffer.alloc(320));
    client.sendJson({ type: 'input_audio.end' });
    const audioStart = await client.waitFor(
        (e) => e.type === 'audio.start',
        { label: `audio.start (${interactionId})`, timeoutMs: 3000 },
    );
    await client.waitFor(
        (e) => e.type === 'audio.end' && e.turn_id === audioStart.turn_id,
        { label: `audio.end (${interactionId})`, timeoutMs: 3000 },
    );
    return audioStart;
}

test('two consecutive push_to_talk turns never share a providerInstanceId in per_turn mode, even though turn 1 completes via the path that never triggers rotateAfterOutputComplete', async () => {
    // rotateAfterOutputComplete: false mirrors geminiLiveProvider.js's actual,
    // hardcoded-false value for hold_to_talk — this is the exact gap the fix
    // closes, not a hypothetical config.
    const { port, close } = await startTestServer({
        mockConfig: {
            rotateOnInterrupt: true,
            rotateAfterOutputComplete: false,
            processingDelayMs: 20,
            chunkIntervalMs: 5,
            chunkCount: 1,
        },
    });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start' });
        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        const turn1 = await runTurn(client, 'ix_turn1');
        const turn2 = await runTurn(client, 'ix_turn2');

        assert.notEqual(
            turn2.provider_instance_id,
            turn1.provider_instance_id,
            'turn 2 must get a fresh provider instance even though turn 1 completed cleanly without rotateAfterOutputComplete firing',
        );
        client.close();
    } finally {
        await close();
    }
});

test('a stale/duplicate audio.end from turn 1, fired after turn 2 has already begun, does not disrupt turn 2', async () => {
    const { port, close, provider } = await startTestServer({
        mockConfig: {
            rotateOnInterrupt: true,
            rotateAfterOutputComplete: false,
            processingDelayMs: 20,
            chunkIntervalMs: 5,
            chunkCount: 1,
        },
    });
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start' });
        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        const turn1 = await runTurn(client, 'ix_turn1');
        // sessions[0] is the initial pre-session.start instance created by
        // providerFactory('initial') before the session_start_config
        // rotation swaps in the one that actually serves turn 1.
        const turn1Session = provider.sessions.find((s) => s.instanceId === turn1.provider_instance_id);
        assert.ok(turn1Session?.lastEndInputContext, 'turn 1 session must have captured its endInput context');

        const turn2 = await runTurn(client, 'ix_turn2');
        assert.notEqual(turn2.provider_instance_id, turn1.provider_instance_id);

        // Simulate the exact production race: turn 1's provider connection
        // sends a second, delayed audio.end after turn 2 is already active.
        turn1Session.lastEndInputContext.onEvent({
            type: 'audio.end',
            response_id: turn1Session.lastEndInputContext.responseId,
            turn_id: turn1Session.lastEndInputContext.turnId,
            elapsed_ms: 9999,
        });

        // Turn 2 must still be able to run a full, independent turn after
        // the stale event — proves it wasn't silently killed or corrupted.
        const turn3 = await runTurn(client, 'ix_turn3');
        assert.ok(turn3.provider_instance_id);
        assert.notEqual(turn3.provider_instance_id, turn2.provider_instance_id);

        client.close();
    } finally {
        await close();
    }
});

'use strict';

// Regression test for the alternating PTT failure (every second press
// didn't start recording). Root cause: isHolding was set AFTER async
// awaits in startTurn(), so a quick pointerup during the microtask gap
// found isHolding===false and no-opped, leaving isHolding leaked to
// true by the late-resolved startTurn(). The next press's endTurn()
// consumed the leaked flag before startTurn() reached its isHolding=true,
// causing it to skip input_audio.start and never show recording.
//
// This test verifies the *server-side* outcome of the fixed client
// behavior: after a stale input_audio.end (quick release where start
// was skipped), 10 consecutive normal PTT turns each produce exactly
// one input_audio.start + one input_audio.end with matching turn_ids,
// distinct provider instances, and zero server errors between cycles.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers/testServer');
const { connect } = require('./helpers/wsTestClient');

async function runTurn(client, interactionId, audioBytes = 320) {
    client.sendJson({
        type: 'input_audio.start',
        mode: 'push_to_talk',
        interaction_id: interactionId,
    });
    if (audioBytes > 0) {
        client.sendBinary(Buffer.alloc(audioBytes));
    }
    client.sendJson({
        type: 'input_audio.end',
        interaction_id: interactionId,
    });
    const audioStart = await client.waitFor(
        (e) => e.type === 'audio.start',
        { label: `audio.start (${interactionId})`, timeoutMs: 10000 },
    );
    const audioEnd = await client.waitFor(
        (e) => e.type === 'audio.end' && e.turn_id === audioStart.turn_id,
        { label: `audio.end (${interactionId})`, timeoutMs: 10000 },
    );
    return { audioStart, audioEnd };
}

// Phase 1: first turn to establish baseline server state
// Phase 2: stale input_audio.end (simulating a quick press-release
//          where the fixed client skips input_audio.start entirely)
// Phase 3: 10 normal cycles, each with 1 start + 1 end
test('PTT race: stale end, then 10 clean cycles — no corruption, no error bleed', async () => {
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
        await client.waitFor(
            (e) => e.type === 'provider.ready',
            { label: 'provider.ready', timeoutMs: 3000 },
        );

        // Phase 1 — one normal turn to establish server state
        const baseline = await runTurn(client, 'ix_baseline');
        assert.ok(baseline.audioStart.turn_id, 'baseline must have turn_id');
        assert.ok(baseline.audioStart.provider_instance_id, 'baseline must have provider_instance_id');
        const baselineProviderId = baseline.audioStart.provider_instance_id;

        // Phase 2 — stale input_audio.end with no matching start.
        // This is exactly what the fixed client sends for a quick press
        // (release during async gap: startTurn sets isHolding=true early,
        // endTurn fires, isHolding=false, startTurn resumes, finds
        // isHolding false, skips input_audio.start entirely).
        client.sendJson({
            type: 'input_audio.end',
            interaction_id: 'ix_quick_release',
        });

        // Phase 3 — 10 normal PTT cycles
        let prevProviderInstanceId = baselineProviderId;
        for (let i = 0; i < 10; i++) {
            const ix = `ix_cycle_${i}`;
            const { audioStart, audioEnd } = await runTurn(client, ix);

            // Every cycle must have matched start/end on the same turn
            assert.ok(audioStart.turn_id, `cycle ${i} start must have turn_id`);
            assert.ok(audioEnd.turn_id, `cycle ${i} end must have turn_id`);
            assert.equal(
                audioEnd.turn_id,
                audioStart.turn_id,
                `cycle ${i}: audio.end turn_id must match audio.start turn_id`,
            );

            // Per-turn rotation: each cycle gets a fresh provider instance
            assert.ok(
                audioStart.provider_instance_id,
                `cycle ${i} must have provider_instance_id`,
            );
            assert.notEqual(
                audioStart.provider_instance_id,
                prevProviderInstanceId,
                `cycle ${i} must get a distinct provider instance (per_turn)`,
            );
            prevProviderInstanceId = audioStart.provider_instance_id;
        }

        client.close();
    } finally {
        await close();
    }
});

// Also verify that the OPPOSITE misorder (input_audio.end arriving
// before input_audio.start — which the old leaked isHolding caused)
// does not break subsequent turns either.
test('misordered end-before-start (old leak pattern) does not corrupt server state', async () => {
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
        await client.waitFor(
            (e) => e.type === 'provider.ready',
            { label: 'provider.ready', timeoutMs: 3000 },
        );

        // First normal turn
        await runTurn(client, 'ix_first');

        // Simulate the leaked-isHolding pattern: end arrives before start
        client.sendJson({
            type: 'input_audio.end',
            interaction_id: 'ix_leaked_end',
        });
        client.sendJson({
            type: 'input_audio.start',
            mode: 'push_to_talk',
            interaction_id: 'ix_leaked_start',
        });
        client.sendBinary(Buffer.alloc(320));
        client.sendJson({
            type: 'input_audio.end',
            interaction_id: 'ix_leaked_start',
        });

        // This misordered turn should still produce a valid response
        const misorderedStart = await client.waitFor(
            (e) => e.type === 'audio.start',
            { label: 'audio.start (misordered)', timeoutMs: 10000 },
        );
        await client.waitFor(
            (e) => e.type === 'audio.end'
                && e.turn_id === misorderedStart.turn_id,
            { label: 'audio.end (misordered)', timeoutMs: 10000 },
        );

        // 5 normal cycles after the misorder — all must be clean
        let prevProviderId = misorderedStart.provider_instance_id;
        for (let i = 0; i < 5; i++) {
            const { audioStart } = await runTurn(client, `ix_recovery_${i}`);
            assert.ok(audioStart.turn_id, `recovery cycle ${i} must have turn_id`);
            assert.ok(audioStart.provider_instance_id, `recovery cycle ${i} must have provider`);
            assert.notEqual(
                audioStart.provider_instance_id,
                prevProviderId,
                `recovery cycle ${i} must rotate provider`,
            );
            prevProviderId = audioStart.provider_instance_id;
        }

        client.close();
    } finally {
        await close();
    }
});

'use strict';

// Regression coverage for the production-confirmed bug: a late, unqualified
// response.done (or delta/transcript/error) from an INTERRUPTED turn's Grok
// WebSocket was being attributed to the NEXT turn, because
// GrokVoiceProviderSession kept a single mutable `this.active` field and
// reused the same socket/object across turns. Root cause trace (grounded in
// real production logs, session_51b5a0e8154640bf, turn3_2a2f9e990c52557e):
// grokVoiceProvider.js's finishResponse() read `this.active` at the moment
// the late message arrived, which by then pointed at the NEW turn.
//
// Fix: GrokVoiceProviderSession now has an explicit active/draining/closed
// lifecycle. interrupt() marks the instance draining (never reassigned
// again -- rotateOnInterrupt is now true, so realtimeServer.js always swaps
// in a *fresh* instance for the next turn before that next turn's
// beginResponse() ever runs). Late messages on a draining instance are
// logged (provider_late_event_ignored) and dropped, never routed to any
// generation's callbacks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('http');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { GrokVoiceProvider } = require('../src/realtime/grokVoiceProvider');
const { connect } = require('./helpers/wsTestClient');

const WS_OPEN = 1;
const WS_CLOSED = 3;

class FakeGrokSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 0;
        this.sentMessages = [];
        // Auto-open on next tick -- deterministic, no real network.
        process.nextTick(() => {
            if (this.readyState === 0) {
                this.readyState = WS_OPEN;
                this.emit('open');
            }
        });
    }

    send(json) {
        this.sentMessages.push(JSON.parse(json));
    }

    close() {
        if (this.readyState === WS_CLOSED) return;
        this.readyState = WS_CLOSED;
        this.emit('close', 1000);
    }

    // Test helper: simulate the Grok server pushing a message down.
    emitServerMessage(payload) {
        this.emit('message', Buffer.from(JSON.stringify(payload)));
    }
}

function startGrokTestServer() {
    const sockets = [];
    // Parallel array to `sockets`: the GrokVoiceProviderSession that owns
    // each socket, so a test can look up "which providerInstanceId does
    // socketA belong to" -- needed because a legitimate reused-instance log
    // line for turn3's OWN completion can share the same `reason` string
    // (e.g. reason=response.done) as the late event under test; only the
    // providerInstanceId distinguishes "turn3's own instance" from "turn2's
    // interrupted instance".
    const sessions = [];
    const grokProvider = new GrokVoiceProvider({
        apiKey: 'test-key',
        webSocketFactory: () => {
            const socket = new FakeGrokSocket();
            sockets.push(socket);
            return socket;
        },
    });

    const logLines = [];
    const originalConsoleLog = console.log;
    console.log = (...args) => {
        logLines.push(args.join(' '));
        originalConsoleLog(...args);
    };

    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });
        attachRealtimeServer(server, {
            providerFactory: (sessionOptions = {}) => {
                const session = grokProvider.createSession(sessionOptions);
                sessions.push(session);
                return session;
            },
            providerMetadata: {
                provider: 'grok',
                model: 'grok-voice-test',
                rotationMode: 'errors_only',
            },
        });
        server.listen(0, () => {
            resolve({
                port: server.address().port,
                sockets,
                sessions,
                logLines,
                close: () => {
                    console.log = originalConsoleLog;
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close();
                    return new Promise((res) => setTimeout(res, 50));
                },
            });
        });
    });
}

async function waitForSocket(sockets, index, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (sockets.length > index && sockets[index].readyState === WS_OPEN) return sockets[index];
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for socket[${index}] to open (have ${sockets.length})`);
}

async function startTurn(client, interactionId) {
    client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: interactionId });
    const started = await client.waitFor((e) => e.type === 'input_audio.start', {
        label: `input_audio.start echo (${interactionId})`,
        timeoutMs: 3000,
    });
    return started.turn_id;
}

for (const lateEventType of [
    'response.done',
    'response.output_audio.delta',
    'response.output_audio_transcript.delta',
    'error',
    'input_audio_buffer.speech_stopped',
]) {
    test(`late ${lateEventType} from an interrupted turn's old Grok socket does not affect the next turn`, async () => {
        const { port, sockets, sessions, logLines, close } = await startGrokTestServer();
        try {
            const client = await connect(port);
            await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
            client.sendJson({ type: 'session.start' });
            await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

            // Step A: start turn2 and receive at least one model/audio event.
            const socketA = await waitForSocket(sockets, sockets.length - 1);
            const turn2TurnId = await startTurn(client, 'ix_turn2');
            client.sendBinary(Buffer.alloc(320));
            client.sendJson({ type: 'input_audio.end' });
            // realtimeServer.js's no-speech gate cancels a push_to_talk
            // generation as soon as a model-output event arrives without a
            // prior non-empty transcript.user -- so, like a real Grok turn,
            // the user transcription must land before any model output.
            socketA.emitServerMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what wine goes with fish' });
            socketA.emitServerMessage({ type: 'response.output_audio_transcript.delta', delta: 'hello' });
            const turn2ModelEvent = await client.waitFor(
                (e) => e.type === 'transcript.model' && e.turn_id === turn2TurnId,
                { label: 'turn2 transcript.model', timeoutMs: 3000 },
            );
            assert.ok(turn2ModelEvent);

            // Step B + C: interrupt turn2 by immediately starting turn3.
            // cancelCurrent('new_input') runs (and emits response.cancelled)
            // BEFORE the input_audio.start echo for the new turn is sent (see
            // startInput() in realtimeServer.js) -- so response.cancelled
            // must be waited for first, or a generic waitFor() looking only
            // for input_audio.start will silently discard it.
            client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk', interaction_id: 'ix_turn3' });
            const cancelled = await client.waitFor(
                (e) => e.type === 'response.cancelled' && e.turn_id === turn2TurnId,
                { label: 'turn2 response.cancelled', timeoutMs: 3000 },
            );
            assert.ok(cancelled);
            const turn3Started = await client.waitFor((e) => e.type === 'input_audio.start', {
                label: 'input_audio.start echo (ix_turn3)',
                timeoutMs: 3000,
            });
            const turn3TurnId = turn3Started.turn_id;
            assert.notEqual(turn3TurnId, turn2TurnId);

            const socketB = await waitForSocket(sockets, sockets.length - 1);
            assert.notEqual(socketB, socketA, "turn3 must get a fresh Grok socket/instance, not reuse turn2's");

            client.sendBinary(Buffer.alloc(320));
            client.sendJson({ type: 'input_audio.end' });
            await new Promise((r) => setTimeout(r, 100));

            // Step D: inject the late event from turn2's OLD socket, now that
            // turn3 has been assigned (socketB exists, turn3 has its own turn_id).
            const lateEventPayload = lateEventType === 'error'
                ? { type: 'error', error: { code: 'some_other_error', message: 'unrelated failure' } }
                : lateEventType === 'response.output_audio.delta'
                    ? { type: lateEventType, delta: Buffer.alloc(8).toString('base64') }
                    : { type: lateEventType };
            socketA.emitServerMessage(lateEventPayload);

            // Give the late event a moment to be (wrongly, if unfixed) processed.
            await new Promise((r) => setTimeout(r, 100));

            // Step E: assertions.
            // (i) no audio.end was emitted for turn3 as a result of the late event.
            let sawTurn3AudioEnd = false;
            try {
                await client.waitFor(
                    (e) => e.type === 'audio.end' && e.turn_id === turn3TurnId,
                    { timeoutMs: 300 },
                );
                sawTurn3AudioEnd = true;
            } catch { /* expected: nothing arrives yet */ }
            assert.equal(sawTurn3AudioEnd, false, 'turn3 must not be completed by turn2\'s late event');
            assert.equal(
                logLines.some((line) => line.includes('stage=ptt_summary') && line.includes(`turnId=${turn3TurnId}`)),
                false,
                'turn3 must not have a ptt_summary line yet -- it has not terminated',
            );

            // (ii) turn3 can still receive/produce its own real completion,
            // proving it was never marked completed/failed by the late event.
            // Verified via server-side logs (ptt_summary) rather than
            // chained client WS events, which is the same signal used to
            // originally diagnose this bug from production.
            socketB.emitServerMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'and a red one' });
            socketB.emitServerMessage({ type: 'response.output_audio.delta', delta: Buffer.alloc(8).toString('base64') });
            socketB.emitServerMessage({ type: 'response.done' });
            await new Promise((r) => setTimeout(r, 300));
            const turn3Summary = logLines.find((line) => line.includes('stage=ptt_summary')
                && line.includes(`turnId=${turn3TurnId}`));
            assert.ok(turn3Summary, 'expected turn3 to reach a ptt_summary line');
            assert.ok(turn3Summary.includes('terminalReason=completed'), `turn3 must complete normally, got: ${turn3Summary}`);
            assert.ok(turn3Summary.includes('modelEvent=true'), `turn3 must have received model output from its OWN provider, got: ${turn3Summary}`);

            // (iii) log evidence: the late event was logged as ignored on the
            // OLD instance, and no provider_session_reused fired because of it.
            const hasLateEventLog = logLines.some((line) => line.includes('provider_late_event_ignored')
                && line.includes(`lateEventType=${lateEventType}`));
            assert.ok(hasLateEventLog, `expected a provider_late_event_ignored log line for ${lateEventType}`);

            // Distinguish "turn3 legitimately reused/completed its OWN
            // instance" (expected, unrelated to the late event, and can
            // share the exact same `reason` text) from "the late event
            // itself caused a reuse log" -- only the providerInstanceId of
            // the OLD (interrupted) instance tells them apart.
            const socketAIndex = sockets.indexOf(socketA);
            const oldProviderInstanceId = sessions[socketAIndex]?.instanceId;
            assert.ok(oldProviderInstanceId, 'test setup: could not resolve socketA\'s providerInstanceId');
            const spuriousReuseLog = logLines.some((line) => line.includes('provider_session_reused')
                && line.includes(`providerInstanceId=${oldProviderInstanceId}`));
            assert.equal(spuriousReuseLog, false, 'must not log provider_session_reused for the interrupted (old) instance');

            const rotationLog = logLines.find((line) => line.includes('provider_session_rotated')
                && line.includes('reason=new_input_after_cancel'));
            assert.ok(rotationLog, 'expected a provider_session_rotated log for the interrupt-driven rotation');
            assert.ok(rotationLog.includes('interruptedProviderInstanceId=') && !rotationLog.includes('interruptedProviderInstanceId=null'));
            assert.ok(rotationLog.includes('replacementProviderInstanceId='));

            client.close();
        } finally {
            await close();
        }
    });
}

test('normal, non-interrupted Grok turns continue reusing the same provider instance', async () => {
    const { port, sockets, close } = await startGrokTestServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        client.sendJson({ type: 'session.start' });
        await client.waitFor((e) => e.type === 'provider.ready', { label: 'provider.ready', timeoutMs: 3000 });

        const socketA = await waitForSocket(sockets, sockets.length - 1);
        const turn1TurnId = await startTurn(client, 'ix_turn1');
        client.sendBinary(Buffer.alloc(320));
        client.sendJson({ type: 'input_audio.end' });
        socketA.emitServerMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'what wine goes with fish' });
        socketA.emitServerMessage({ type: 'response.output_audio.delta', delta: Buffer.alloc(8).toString('base64') });
        await client.waitFor((e) => e.type === 'audio.start' && e.turn_id === turn1TurnId, { timeoutMs: 2000 });
        socketA.emitServerMessage({ type: 'response.done' });
        await client.waitFor((e) => e.type === 'audio.end' && e.turn_id === turn1TurnId, { timeoutMs: 2000 });

        // Turn completed normally (not interrupted) -> next turn should reuse
        // the same socket/instance, per requirement 10.
        await startTurn(client, 'ix_turn2');
        client.sendBinary(Buffer.alloc(320));
        client.sendJson({ type: 'input_audio.end' });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(sockets.length, 1, 'a normally-completed turn must not trigger a new Grok socket for the next turn');
        client.close();
    } finally {
        await close();
    }
});

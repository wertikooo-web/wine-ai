'use strict';

// Regression coverage for the "benign Grok cancellation race" bug: our own
// interrupt() fires response.cancel without waiting for a matching
// response.created, so whenever that cancel lands after Grok already
// finished the response naturally, Grok replies with a plain
// invalid_request_error "Cancellation failed: no active response found".
// That error carries no consequence (nothing was left running) but was
// previously treated as fatal by handleMessage()'s catch-all `type === 'error'`
// branch, which called failActive() -> response.failed -> provider session
// rotation on every single barge-in. See src/realtime/grokVoiceProvider.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
    GrokVoiceProvider,
    isBenignCancellationRace,
} = require('../src/realtime/grokVoiceProvider');

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.sent = [];
    }

    send(payload) {
        this.sent.push(JSON.parse(payload));
    }

    close() {
        this.readyState = 3;
        this.emit('close', 1000);
    }
}

function createContext(events, audioChunks) {
    return {
        generationId: 'generation_test',
        responseId: null,
        turnId: 'turn_test',
        signal: { cancelled: false, cancel() {} },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        onSessionEvent: (event) => events.push(event),
        log: (stage, data) => events.push({ type: `log:${stage}`, ...data }),
    };
}

test('isBenignCancellationRace matches only the exact known Grok cancel-race error', () => {
    assert.equal(
        isBenignCancellationRace({ error: { code: 'invalid_request_error', message: 'Cancellation failed: no active response found' } }),
        true,
    );
    // Same code, different message -- a real invalid_request_error (bad
    // payload, malformed turn, etc.) must NOT be swallowed as benign.
    assert.equal(
        isBenignCancellationRace({ error: { code: 'invalid_request_error', message: 'Invalid audio format' } }),
        false,
    );
    // Same message text, different/missing code -- also must not match.
    assert.equal(
        isBenignCancellationRace({ error: { code: 'server_error', message: 'Cancellation failed: no active response found' } }),
        false,
    );
    assert.equal(isBenignCancellationRace({}), false);
    assert.equal(isBenignCancellationRace(null), false);
});

test('a benign cancellation-race error does not fail the generation, rotate the session, or stop the current turn', async () => {
    const socket = new FakeSocket();
    const provider = new GrokVoiceProvider({
        apiKey: 'test-key',
        voiceId: 'rex',
        webSocketFactory: () => {
            queueMicrotask(() => socket.emit('open'));
            return socket;
        },
    });
    const session = provider.createSession({ systemInstructionText: 'Wine expert' });
    const events = [];
    const audioChunks = [];
    const context = createContext(events, audioChunks);
    const instanceIdBeforeError = session.instanceId;

    session.beginResponse(context);
    await session.connect();
    session.sendAudio(Buffer.from([1, 0, 2, 0]));
    await session.endInput(context);

    // The exact wire shape Grok sends for this race.
    session.handleMessage(JSON.stringify({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'Cancellation failed: no active response found' },
    }));

    assert.equal(
        events.some((event) => event.type === 'response.failed'),
        false,
        'benign cancel race must not emit response.failed',
    );
    assert.equal(
        events.some((event) => event.type === 'log:provider_error'),
        false,
        'benign cancel race must not be logged as a fatal provider_error',
    );
    assert.equal(
        events.some((event) => event.type === 'log:benign_cancel_race'),
        true,
        'benign cancel race must be logged distinctly',
    );
    assert.equal(session.instanceId, instanceIdBeforeError, 'providerInstanceId must not change (no rotation)');
    assert.ok(session.active, 'the current turn/session state must survive the benign error');

    // The next turn continues normally on the SAME session/socket.
    session.handleMessage(JSON.stringify({
        type: 'response.output_audio.delta',
        delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
    }));
    session.handleMessage(JSON.stringify({ type: 'response.done' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(audioChunks.length, 1, 'audio for the next turn must still be delivered on the same session');
    assert.equal(events.some((event) => event.type === 'audio.end'), true);
});

test('a genuinely fatal invalid_request_error still fails the generation as before (no regression)', async () => {
    const socket = new FakeSocket();
    const provider = new GrokVoiceProvider({
        apiKey: 'test-key',
        voiceId: 'rex',
        webSocketFactory: () => {
            queueMicrotask(() => socket.emit('open'));
            return socket;
        },
    });
    const session = provider.createSession({ systemInstructionText: 'Wine expert' });
    const events = [];
    const audioChunks = [];
    const context = createContext(events, audioChunks);

    session.beginResponse(context);
    await session.connect();

    session.handleMessage(JSON.stringify({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'Invalid audio format' },
    }));

    assert.equal(
        events.some((event) => event.type === 'response.failed'),
        true,
        'a real invalid_request_error must still fail the generation',
    );
});

'use strict';

// Regression (production 29 Sep, session_1048e0ebb8ca6c74): in Free
// Conversation the user spoke during an 8 s tool call; Gemini interrupted
// and sent turnComplete with no model output yet, which marked the turn as
// "closed during input". Gemini then answered normally in the SAME
// generation (audio played), but the stale mark survived, so ending the
// input later raised a false response.failed
// (provider_turn_closed_during_input) and the UI showed "error".
// Model output for the generation must clear that mark; a turn that really
// produced nothing must still fail as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');

function makeActiveSession() {
    const provider = new GeminiLiveProvider({ apiKey: 'unused-in-this-test' });
    const session = provider.createSession({ voiceMode: 'tap_to_start', systemInstructionText: 'x', onProviderEvent: () => {} });
    const events = [];
    const logs = [];
    const context = {
        generationId: 'generation_t3',
        responseId: 'response_t3',
        turnId: 'turn3',
        signal: { cancelled: false },
        onEvent: (event) => events.push(event),
        onSessionEvent: () => {},
        onAudioChunk: () => {},
        log: (stage, data) => logs.push({ stage, ...data }),
    };
    session.active = {
        ...context,
        startedAt: Date.now(),
        audioStarted: false,
        modelOutputStarted: false,
        inputEnded: false,
        chunkIndex: 0,
        inputTranscriptionReceived: true,
    };
    // endInput() must not open a real socket in this unit test.
    session.connect = async () => {};
    session.flushPendingAudio = () => {};
    return { session, context, events, logs };
}

const PCM = Buffer.alloc(960).toString('base64');

test('turnComplete without output during input, then a real answer in the same generation: ending input is NOT a failure', async () => {
    const { session, context, events } = makeActiveSession();

    session.handleMessage({ serverContent: { interrupted: true } });
    session.handleMessage({ serverContent: { turnComplete: true } });
    assert.equal(session.turnClosedDuringInput?.generationId, 'generation_t3', 'precondition: the turn was marked closed during input');

    session.handleMessage({ serverContent: { outputTranscription: { text: 'Зелёное вино — это vinho verde…' } } });
    session.handleMessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: PCM } }] } } });
    session.handleMessage({ serverContent: { generationComplete: true } });
    assert.equal(session.turnClosedDuringInput, null, 'model output for the same generation clears the stale mark');

    await session.endInput(context);
    assert.equal(events.filter((e) => e.type === 'response.failed').length, 0, 'no false response.failed after a turn that was answered');
});

test('a turn that really produced no output still fails on input end (unchanged behavior)', async () => {
    const { session, context, events } = makeActiveSession();

    session.handleMessage({ serverContent: { turnComplete: true } });
    await session.endInput(context);
    const failed = events.find((e) => e.type === 'response.failed');
    assert.ok(failed, 'still reported');
    assert.equal(failed.reason, 'provider_turn_closed_during_input');
});

test('output of a different generation does not clear another generation\'s mark', () => {
    const { session } = makeActiveSession();
    session.handleMessage({ serverContent: { turnComplete: true } });
    session.turnClosedDuringInput.generationId = 'generation_other';
    session.handleMessage({ serverContent: { outputTranscription: { text: 'x' } } });
    assert.equal(session.turnClosedDuringInput?.generationId, 'generation_other');
});

'use strict';

// This file's frames are silent placeholder audio, not real speech — the
// server's no-speech gate (realtimeServer.js's countLoudSamples/endInput)
// would otherwise cancel every turn here before it ever reaches the mock
// provider. Disable it for this file only (see noSpeechAmplitudeThreshold()
// in realtimeServer.js, read live rather than cached at module load).
process.env.NO_SPEECH_MIN_LOUD_MS = '0';

// Tests for the voiceMode-aware turn-detection split added to
// src/realtime/geminiLiveProvider.js, src/realtime/grokVoiceProvider.js, and
// src/realtime/realtimeServer.js:
//   hold_to_talk -> manual turn boundaries (unchanged, existing mechanism)
//   tap_to_start -> provider-native VAD (Gemini automaticActivityDetection /
//                   Grok server_vad) drives turn boundaries instead of the
//                   client-side RMS timer that used to do this.
// Uses node:test (matches tests/grokProvider.test.js's own convention for
// these two provider files).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
    GeminiLiveProvider,
    buildGeminiRealtimeInputConfig,
} = require('../src/realtime/geminiLiveProvider');
const {
    GrokVoiceProvider,
    buildGrokSessionConfig,
} = require('../src/realtime/grokVoiceProvider');
const { attachRealtimeServer } = require('../src/realtime/realtimeServer');
const { connect } = require('./helpers/wsTestClient');

function createContext(events, audioChunks, overrides = {}) {
    return {
        generationId: 'generation_test',
        responseId: null,
        turnId: 'turn_test',
        mode: 'tap_to_start',
        signal: {
            cancelled: false,
            cancel(reason) { this.cancelled = true; this.reason = reason; },
        },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        onSessionEvent: (event) => events.push(event),
        log: () => {},
        ...overrides,
    };
}

// ---- 1. Gemini config shape (real @google/genai enums — installed
// dependency, not faked) ----
test('Gemini realtime input config: hold_to_talk keeps manual/no-interruption/all-input', async () => {
    const { ActivityHandling, TurnCoverage, StartSensitivity, EndSensitivity } = await import('@google/genai');
    const config = buildGeminiRealtimeInputConfig({ ActivityHandling, TurnCoverage, StartSensitivity, EndSensitivity, voiceMode: 'hold_to_talk' });
    assert.equal(config.automaticActivityDetection.disabled, true);
    assert.equal(config.activityHandling, ActivityHandling.NO_INTERRUPTION);
    assert.equal(config.turnCoverage, TurnCoverage.TURN_INCLUDES_ALL_INPUT);
});

test('Gemini realtime input config: tap_to_start enables automatic detection with interrupts', async () => {
    const { ActivityHandling, TurnCoverage, StartSensitivity, EndSensitivity } = await import('@google/genai');
    const config = buildGeminiRealtimeInputConfig({ ActivityHandling, TurnCoverage, StartSensitivity, EndSensitivity, voiceMode: 'tap_to_start' });
    assert.equal(config.automaticActivityDetection.disabled, false);
    assert.equal(config.activityHandling, ActivityHandling.START_OF_ACTIVITY_INTERRUPTS);
    assert.equal(config.turnCoverage, TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY);
    assert.ok(typeof config.automaticActivityDetection.silenceDurationMs === 'number');
});

// ---- 2. Gemini session: no manual activity markers sent in tap_to_start ----
test('Gemini session: sendAudioNow skips manual activityStart in tap_to_start mode', () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'tap_to_start' });
    const sent = [];
    session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
    session.active = { activityStarted: false, log: () => {} };

    session.sendAudioNow(Buffer.from([1, 2, 3, 4]));

    assert.equal(sent.some((p) => p.activityStart), false, 'no manual activityStart sent while automatic detection is enabled');
    assert.equal(sent.some((p) => p.audio), true, 'raw audio is still forwarded');
});

test('Gemini session: sendAudioNow DOES send manual activityStart in hold_to_talk mode', () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'hold_to_talk' });
    const sent = [];
    session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
    session.active = { activityStarted: false, log: () => {} };

    session.sendAudioNow(Buffer.from([1, 2, 3, 4]));

    assert.equal(sent.some((p) => p.activityStart), true, 'manual activityStart is still required for the unchanged PTT path');
});

test('Gemini session: endInput sends nothing in tap_to_start (no manual activityEnd)', async () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'tap_to_start' });
    const sent = [];
    session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
    session.connect = async () => {}; // bypass the real network connect()
    session.active = { activityStarted: true, activityEnded: false, inputEnded: false, chunkIndex: 0, log: () => {} };

    await session.endInput(createContext([], [], { mode: 'tap_to_start' }));

    assert.equal(sent.length, 0, 'no activityEnd/silence-tail marker sent — the provider already ended the turn itself');
});

test('Gemini session: endInput DOES send manual activityEnd in hold_to_talk (text mode)', async () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'hold_to_talk' });
    const sent = [];
    session.session = { sendRealtimeInput: (payload) => sent.push(payload) };
    session.connect = async () => {};
    session.active = { activityStarted: true, activityEnded: false, inputEnded: false, chunkIndex: 0, log: () => {} };

    await session.endInput(createContext([], [], { mode: 'text' }));

    assert.equal(sent.some((p) => p.activityEnd), true, 'hold_to_talk still needs the manual activityEnd marker');
});

// ---- 3. Grok config shape ----
test('Grok session config: hold_to_talk keeps turn_detection null', () => {
    const config = buildGrokSessionConfig({ systemInstructionText: 'x', voiceMode: 'hold_to_talk' }, { voiceId: 'eve' });
    assert.equal(config.turn_detection, null);
});

test('Grok session config: tap_to_start enables server_vad', () => {
    const config = buildGrokSessionConfig({ systemInstructionText: 'x', voiceMode: 'tap_to_start' }, { voiceId: 'eve' });
    assert.equal(config.turn_detection.type, 'server_vad');
    assert.ok(typeof config.turn_detection.silence_duration_ms === 'number');
});

// ---- 4. Grok session: no manual commit/response.create in tap_to_start ----
test('Grok session: endInput sends nothing in tap_to_start (commit is forbidden under server_vad)', async () => {
    const provider = new GrokVoiceProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'tap_to_start', systemInstructionText: 'x' });
    session.connect = async () => {};
    const sent = [];
    session.sendRaw = (payload) => { sent.push(payload); return true; };
    session.active = { generationId: 'generation_test', signal: { cancelled: false } };

    await session.endInput(createContext([], [], { mode: 'tap_to_start' }));

    assert.equal(sent.length, 0, 'no input_audio_buffer.commit / response.create sent — server_vad owns the turn boundary');
});

test('Grok session: endInput DOES send commit+response.create in hold_to_talk', async () => {
    const provider = new GrokVoiceProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'hold_to_talk', systemInstructionText: 'x' });
    session.connect = async () => {};
    const sent = [];
    session.sendRaw = (payload) => { sent.push(payload); return true; };
    session.active = { generationId: 'generation_test', signal: { cancelled: false } };

    await session.endInput(createContext([], [], { mode: 'push_to_talk' }));

    assert.deepEqual(sent.map((p) => p.type), ['input_audio_buffer.commit', 'response.create']);
});

test('Grok session: speech_started/speech_stopped invoke native callbacks only in tap_to_start', () => {
    const provider = new GrokVoiceProvider({ apiKey: 'fake-key' });
    let starts = 0;
    let stops = 0;
    const tapSession = provider.createSession({
        voiceMode: 'tap_to_start',
        systemInstructionText: 'x',
        onUserSpeechStarted: () => { starts += 1; },
        onUserSpeechStopped: () => { stops += 1; },
    });
    tapSession.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    tapSession.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    assert.equal(starts, 1);
    assert.equal(stops, 1);

    let holdStarts = 0;
    const holdSession = provider.createSession({
        voiceMode: 'hold_to_talk',
        systemInstructionText: 'x',
        onUserSpeechStarted: () => { holdStarts += 1; },
    });
    holdSession.handleMessage(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    assert.equal(holdStarts, 0, 'hold_to_talk must ignore native speech signals entirely');
});

// ---- 5. realtimeServer.js integration: provider-native turns, no client
// input_audio.end at all, using a hand-written fake provider that mimics
// the two providers' native-callback contract (no real Gemini/Grok
// credentials needed/available in this sandbox). ----
class FakeVadProvider {
    createSession(options = {}) {
        return new FakeVadProviderSession(options);
    }
}

class FakeVadProviderSession {
    constructor(options) {
        this.name = 'fake_vad';
        this.instanceId = 'fake_vad_session';
        this.voiceMode = options.voiceMode;
        this.onUserSpeechStarted = options.onUserSpeechStarted;
        this.onUserSpeechStopped = options.onUserSpeechStopped;
        this.rotateOnInterrupt = false;
        this.rotateAfterOutputComplete = false;
        this.closed = false;
        this.active = null;
        this.sentAudioBytes = 0;
    }

    sendAudio(buffer) {
        if (this.closed) return;
        this.sentAudioBytes += Buffer.isBuffer(buffer) ? buffer.length : 0;
    }

    beginResponse(context) {
        this.active = context;
    }

    async endInput(context) {
        if (this.closed || context.signal.cancelled) return;
        // realtimeServer.js's no-speech gate (emitProviderEvent()) treats an
        // empty inputTranscription as ground truth that nothing was said —
        // real providers only ever emit transcript.user with non-empty text,
        // so this fake must too, or every turn here gets wrongly cancelled.
        context.onEvent({ type: 'transcript.user', response_id: context.responseId, turn_id: context.turnId, text: 'fake utterance' });
        context.onEvent({ type: 'audio.start', response_id: context.responseId, turn_id: context.turnId });
        context.onAudioChunk({ type: 'audio.chunk', response_id: context.responseId, turn_id: context.turnId, chunk_index: 0, audio_base64: 'AAA=' });
        context.onEvent({ type: 'audio.end', response_id: context.responseId, turn_id: context.turnId, cause: 'fake_done' });
    }

    interrupt() {}
    close() { this.closed = true; }

    // Test-only hook simulating what a real provider's handleMessage() does
    // internally when its own native VAD fires.
    simulateNativeSpeechStarted() { this.onUserSpeechStarted?.(); }
    simulateNativeSpeechStopped() { this.onUserSpeechStopped?.(); }
}

function startFakeVadServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        const fakeProvider = new FakeVadProvider();
        let lastSession = null;
        attachRealtimeServer(server, {
            providerFactory: (sessionOptions = {}) => {
                lastSession = fakeProvider.createSession(sessionOptions);
                return lastSession;
            },
            providerMetadata: { provider: 'fake_vad', model: 'fake' },
        });
        server.listen(0, () => {
            resolve({
                port: server.address().port,
                getSession: () => lastSession,
                close: () => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close();
                    return new Promise((res) => setTimeout(res, 50));
                },
            });
        });
    });
}

function silenceFrame(samples = 160) {
    return Buffer.alloc(samples * 2);
}

test('realtimeServer: tap_to_start turn opened by the client is finalized by a native speech-stop signal, with no client input_audio.end', async () => {
    // personaStore defaults to hold_to_talk; force tap_to_start for this
    // server instance the same way the dashboard's switcher does (via the
    // persisted preference realtimeServer.js reads at session-create time).
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;
    personaStore.getVoiceMode = () => 'tap_to_start';

    const { port, getSession, close } = await startFakeVadServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        // The single client-sent input_audio.start that opens the whole
        // tap_to_start conversation (the tap). Real dashboard.html reports
        // its actual mic track.getSettings() here (see resumeTapListening());
        // handleNativeSpeechStarted() now requires this confirmation before
        // trusting a later native "speech started" to open a new turn.
        client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', micEchoCancellation: true, micTrackId: 'test-track' });
        const firstStart = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'first input_audio.start echo' });
        assert.ok(firstStart.generation_id);

        client.sendBinary(silenceFrame());
        // Binary frames travel over the real (loopback) TCP socket, unlike
        // simulateNativeSpeechStopped() below, which is a direct in-process
        // call with no I/O at all — give the frame a real tick to actually
        // reach the server's onBinary handler before racing it against the
        // synchronous native-VAD simulation, otherwise the ordering between
        // "frame arrives" and "turn closes" is nondeterministic.
        await new Promise((resolve) => setTimeout(resolve, 30));
        const bytesAfterFirstFrame = getSession().sentAudioBytes;
        assert.ok(bytesAfterFirstFrame > 0, 'the first frame reached the provider while the turn was open');

        // No client input_audio.end is ever sent for this utterance — the
        // provider's own native VAD ends it instead.
        const session = getSession();
        session.simulateNativeSpeechStopped();
        const firstEnd = await client.waitFor((e) => e.type === 'input_audio.end', { label: 'native-triggered input_audio.end' });
        assert.equal(firstEnd.end_reason, 'provider_vad');
        assert.equal(firstEnd.generation_id, firstStart.generation_id);

        await client.waitFor((e) => e.type === 'audio.end', { label: 'first turn audio.end' });

        // Audio sent DURING the gap (no turn open) must still reach the
        // provider — this is what lets native VAD detect the next utterance
        // at all. Verify it is not dropped.
        const bytesBeforeGapFrame = session.sentAudioBytes;
        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(session.sentAudioBytes > bytesBeforeGapFrame, 'audio sent between utterances must still reach the provider in tap_to_start');

        // Second utterance: opened ENTIRELY by the provider's native
        // speech-start signal — no client input_audio.start message at all.
        session.simulateNativeSpeechStarted();
        const secondStart = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'native-triggered input_audio.start' });
        assert.notEqual(secondStart.generation_id, firstStart.generation_id, 'a genuinely new generation was opened');

        session.simulateNativeSpeechStopped();
        const secondEnd = await client.waitFor((e) => e.type === 'input_audio.end', { label: 'second native-triggered input_audio.end' });
        assert.equal(secondEnd.generation_id, secondStart.generation_id);

        client.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
        await close();
    }
});

test('realtimeServer: hold_to_talk is unaffected — client input_audio.end still required, native callbacks never fire', async () => {
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;
    personaStore.getVoiceMode = () => 'hold_to_talk';

    const { port, getSession, close } = await startFakeVadServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        client.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(silenceFrame());

        const session = getSession();
        // A native signal must be a no-op in hold_to_talk — nothing should
        // happen (no turn exists yet to finalize).
        session.simulateNativeSpeechStopped();

        client.sendJson({ type: 'input_audio.end' });
        const end = await client.waitFor((e) => e.type === 'input_audio.end');
        assert.notEqual(end.end_reason, 'provider_vad', 'hold_to_talk turns end via the explicit client message, not a native signal');

        await client.waitFor((e) => e.type === 'audio.end');

        // Audio sent with no active turn must be dropped in hold_to_talk
        // (unchanged behavior) — starve-test: sendAudio byte count must not
        // grow from a frame sent after this turn's audio.end.
        const bytesAfterTurn = session.sentAudioBytes;
        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(session.sentAudioBytes, bytesAfterTurn, 'hold_to_talk must still drop audio frames outside an active turn');

        client.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
        await close();
    }
});

test('realtimeServer: redundant endInput is safely ignored (no duplicate input_audio.end)', async () => {
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;
    personaStore.getVoiceMode = () => 'tap_to_start';

    const { port, getSession, close } = await startFakeVadServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', micEchoCancellation: true, micTrackId: 'test-track' });
        await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));

        const session = getSession();
        session.simulateNativeSpeechStopped();
        await client.waitFor((e) => e.type === 'input_audio.end', { label: 'first (vad) end' });

        client.sendJson({ type: 'input_audio.end' });

        let hasDuplicate = false;
        try {
            const event = await client.nextEvent(200);
            hasDuplicate = event.type === 'input_audio.end';
        } catch {
            // timeout expected
        }
        assert.equal(hasDuplicate, false, 'redundant endInput must not emit a second input_audio.end');

        client.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
        await close();
    }
});

test('realtimeServer: mode switching lifecycle — tap_to_start then hold_to_talk session is clean', async () => {
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;

    try {
        // Phase 1: tap_to_start session
        personaStore.getVoiceMode = () => 'tap_to_start';
        const server1 = await startFakeVadServer();
        const client1 = await connect(server1.port);
        await client1.waitFor((e) => e.type === 'session.ready');
        client1.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client1.waitFor((e) => e.type === 'session.config.applied');

        client1.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', micEchoCancellation: true, micTrackId: 'test-track' });
        await client1.waitFor((e) => e.type === 'input_audio.start');
        client1.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));

        const s1 = server1.getSession();
        s1.simulateNativeSpeechStopped();
        const end1 = await client1.waitFor((e) => e.type === 'input_audio.end', { label: 'tap_to_start end' });
        assert.equal(end1.end_reason, 'provider_vad', 'tap_to_start turn must end via provider VAD');

        const bytesAfterTurn1 = s1.sentAudioBytes;
        client1.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.ok(s1.sentAudioBytes > bytesAfterTurn1, 'inter-utterance audio must still flow in tap_to_start');

        s1.simulateNativeSpeechStarted();
        await client1.waitFor((e) => e.type === 'input_audio.start', { label: 'native triggered start 2' });
        s1.simulateNativeSpeechStopped();
        await client1.waitFor((e) => e.type === 'input_audio.end', { label: 'vad end 2' });

        client1.close();
        await server1.close();

        // Phase 2: switch to hold_to_talk — completely new session
        personaStore.getVoiceMode = () => 'hold_to_talk';
        const server2 = await startFakeVadServer();
        const client2 = await connect(server2.port);
        await client2.waitFor((e) => e.type === 'session.ready');
        client2.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client2.waitFor((e) => e.type === 'session.config.applied');

        client2.sendJson({ type: 'input_audio.start', mode: 'push_to_talk' });
        await client2.waitFor((e) => e.type === 'input_audio.start');
        client2.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));

        const s2 = server2.getSession();
        const bytesBeforeVad = s2.sentAudioBytes;
        s2.simulateNativeSpeechStopped();
        await new Promise((resolve) => setImmediate(resolve));

        client2.sendJson({ type: 'input_audio.end' });
        const end2 = await client2.waitFor((e) => e.type === 'input_audio.end', { label: 'hold_to_talk end' });
        assert.notEqual(end2.end_reason, 'provider_vad', 'hold_to_talk must use client-driven end');

        const bytesAfterTurn2 = s2.sentAudioBytes;
        client2.sendBinary(silenceFrame());
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(s2.sentAudioBytes, bytesAfterTurn2, 'hold_to_talk must drop audio outside an active turn');

        client2.close();
        await server2.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
    }
});

// ---- 6. Repeated barge-in regression (production incident, 2026-07-31):
// the first client_barge_in worked, every one after it silently did nothing
// — input just piled up until input_replay_buffer_full. Root cause:
// cancelCurrent() never stamped inputEndedAt, so a genuinely-still-streaming
// generation that got barge-in-cancelled stayed "open" forever (hasOpenTurn
// only ever looked at inputEndedAt), permanently blocking every later
// handleNativeSpeechStarted() call. Unlike FakeVadProviderSession above
// (whose endInput() auto-completes synchronously — never actually
// "streaming" when a barge-in would hit it), this fake keeps a response
// open until the test explicitly finishes it, so a barge-in can land on a
// genuinely in-flight generation, matching the real Gemini/Grok failure
// mode. ----
class StreamingFakeVadProviderSession {
    constructor(options) {
        this.name = 'streaming_fake_vad';
        this.instanceId = 'streaming_fake_vad_session';
        this.voiceMode = options.voiceMode;
        this.onUserSpeechStarted = options.onUserSpeechStarted;
        this.onUserSpeechStopped = options.onUserSpeechStopped;
        this.rotateOnInterrupt = false;
        this.rotateAfterOutputComplete = false;
        this.closed = false;
        this.active = null;
        this.sentAudioBytes = 0;
        // generationId -> context, kept even after this.active moves on, so
        // a test can simulate a LATE natural-completion event arriving for
        // an already barge-in-cancelled generation.
        this.contextsByGenerationId = new Map();
    }

    sendAudio(buffer) {
        if (this.closed) return;
        this.sentAudioBytes += Buffer.isBuffer(buffer) ? buffer.length : 0;
    }

    beginResponse(context) {
        this.active = context;
        this.contextsByGenerationId.set(context.generationId, context);
    }

    async endInput(context) {
        if (this.closed || context.signal.cancelled) return;
        context.onEvent({ type: 'transcript.user', response_id: context.responseId, turn_id: context.turnId, text: 'fake utterance' });
        context.onEvent({ type: 'audio.start', response_id: context.responseId, turn_id: context.turnId });
        context.onAudioChunk({ type: 'audio.chunk', response_id: context.responseId, turn_id: context.turnId, chunk_index: 0, audio_base64: 'AAA=' });
        // Deliberately NO audio.end here — the response stays "streaming"
        // (this.active still set) until the test calls completeNaturally()
        // or the server-side barge-in path cancels it, exactly like a real
        // in-flight Gemini/Grok response would.
    }

    // Simulates the model finishing its own reply on its own (no barge-in).
    // Mirrors geminiLiveProvider.js's emitOutputEnd(): fires audio.end, then
    // — the actual mechanism this bug lived in — calls onUserSpeechStopped
    // with the generation's own id.
    completeNaturally(generationId) {
        const context = this.contextsByGenerationId.get(generationId);
        if (!context) return;
        context.onEvent({ type: 'audio.end', response_id: context.responseId, turn_id: context.turnId, cause: 'fake_generation_complete' });
        if (this.voiceMode === 'tap_to_start') {
            this.onUserSpeechStopped?.(generationId);
        }
        if (this.active === context) this.active = null;
    }

    interrupt() {}
    close() { this.closed = true; }

    simulateNativeSpeechStarted() { this.onUserSpeechStarted?.(); }
    simulateNativeSpeechStopped() { this.onUserSpeechStopped?.(); }
}

function startStreamingFakeVadServer() {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        let lastSession = null;
        attachRealtimeServer(server, {
            providerFactory: (sessionOptions = {}) => {
                lastSession = new StreamingFakeVadProviderSession(sessionOptions);
                return lastSession;
            },
            providerMetadata: { provider: 'streaming_fake_vad', model: 'fake' },
        });
        server.listen(0, () => {
            resolve({
                port: server.address().port,
                getSession: () => lastSession,
                close: () => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close();
                    return new Promise((res) => setTimeout(res, 50));
                },
            });
        });
    });
}

test('realtimeServer: three consecutive barge-ins each open a fresh turn (A->barge-in->B->barge-in->C->barge-in->D)', async () => {
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;
    personaStore.getVoiceMode = () => 'tap_to_start';

    const { port, getSession, close } = await startStreamingFakeVadServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');
        const session = getSession();

        // Opens generation A (the client's own tap).
        client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', micEchoCancellation: true, micTrackId: 'test-track' });
        const startA = await client.waitFor((e) => e.type === 'input_audio.start', { label: 'A start' });
        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));
        session.simulateNativeSpeechStopped();
        await client.waitFor((e) => e.type === 'input_audio.end', { label: 'A end' });
        await client.waitFor((e) => e.type === 'audio.start', { label: 'A response starts streaming' });

        let previousGenerationId = startA.generation_id;
        const letters = ['B', 'C', 'D'];

        for (let cycle = 0; cycle < 3; cycle += 1) {
            const cancelledGenerationId = previousGenerationId;
            const bytesBeforeReplay = session.sentAudioBytes;

            // The barge-in: client sends client_barge_in while A/B/C is still
            // actively streaming (this.active is still set — never completed).
            client.sendJson({ type: 'session.interrupt', reason: 'client_barge_in' });
            const cancelled = await client.waitFor((e) => e.type === 'response.cancelled', { label: `cycle ${cycle} response.cancelled` });
            assert.equal(cancelled.generation_id, cancelledGenerationId, 'cancelled exactly the current (old) generation');

            // A late natural-completion for the JUST-cancelled generation must
            // be ignored — it must not touch the next generation's turn.
            session.completeNaturally(cancelledGenerationId);

            // Next utterance: opened entirely by native VAD (no client
            // input_audio.start), exactly as production logs showed native
            // speech-start firing for it. This is the exact call that
            // silently no-op'd for every barge-in after the first, pre-fix.
            session.simulateNativeSpeechStarted();
            const nextStart = await client.waitFor((e) => e.type === 'input_audio.start', { label: `cycle ${cycle} next start (${letters[cycle]})` });
            assert.notEqual(nextStart.generation_id, cancelledGenerationId, 'a genuinely new generation was opened, not the cancelled one');

            // Audio now attaches to the NEW generation, not the cancelled one.
            client.sendBinary(silenceFrame());
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.ok(session.sentAudioBytes > bytesBeforeReplay, 'audio for the new episode reached the provider');

            session.simulateNativeSpeechStopped();
            const nextEnd = await client.waitFor((e) => e.type === 'input_audio.end', { label: `cycle ${cycle} next end (${letters[cycle]})` });
            assert.equal(nextEnd.generation_id, nextStart.generation_id, 'the turn that closed is the new generation, not the stale cancelled one');
            await client.waitFor((e) => e.type === 'audio.start', { label: `cycle ${cycle} ${letters[cycle]} response starts streaming` });

            previousGenerationId = nextStart.generation_id;
        }

        // No stray event (e.g. an 'error' from a confused turn-state) shows
        // up before the next expected one — the zombie-open-turn bug
        // eventually surfaced as input_replay_buffer_full/silence, not a
        // clean error, so absence of an unexpected event here is the
        // meaningful check; each waitFor() above already failed loudly (via
        // its own timeout) if the real event never arrived.
        client.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
        await close();
    }
});

test('realtimeServer: a late natural-completion for a barge-in-cancelled generation cannot close the new turn', async () => {
    const personaStore = require('../src/persona/personaStore');
    const originalGetVoiceMode = personaStore.getVoiceMode;
    personaStore.getVoiceMode = () => 'tap_to_start';

    const { port, getSession, close } = await startStreamingFakeVadServer();
    try {
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');
        const session = getSession();

        client.sendJson({ type: 'input_audio.start', mode: 'tap_to_start', micEchoCancellation: true, micTrackId: 'test-track' });
        const startA = await client.waitFor((e) => e.type === 'input_audio.start');
        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));
        session.simulateNativeSpeechStopped();
        await client.waitFor((e) => e.type === 'input_audio.end');
        await client.waitFor((e) => e.type === 'audio.start');

        client.sendJson({ type: 'session.interrupt', reason: 'client_barge_in' });
        await client.waitFor((e) => e.type === 'response.cancelled');

        // Open generation B via native VAD before the stale completion for A
        // arrives — this is the exact ordering from the user's spec (A
        // cancelled -> B starts -> late event for A must not touch B).
        session.simulateNativeSpeechStarted();
        const startB = await client.waitFor((e) => e.type === 'input_audio.start');
        assert.notEqual(startB.generation_id, startA.generation_id);

        client.sendBinary(silenceFrame());
        await new Promise((resolve) => setTimeout(resolve, 30));

        // Late arrival: A's natural completion reaches the server only now,
        // after B has already opened. It must be dropped as stale, not
        // close B's still-open turn.
        session.completeNaturally(startA.generation_id);

        let sawSpuriousEnd = false;
        try {
            const event = await client.nextEvent(200);
            sawSpuriousEnd = event.type === 'input_audio.end';
        } catch {
            // timeout expected — B's turn must still be open
        }
        assert.equal(sawSpuriousEnd, false, "B's turn must still be open after A's late completion");

        // B still closes normally via its own native VAD stop.
        session.simulateNativeSpeechStopped();
        const endB = await client.waitFor((e) => e.type === 'input_audio.end');
        assert.equal(endB.generation_id, startB.generation_id);

        client.close();
    } finally {
        personaStore.getVoiceMode = originalGetVoiceMode;
        await close();
    }
});

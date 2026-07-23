'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
    GrokVoiceProvider,
    buildGrokSessionConfig,
} = require('../src/realtime/grokVoiceProvider');
const { createRealtimeProviderRegistry } = require('../src/realtime/providerRegistry');
const { listGrokVoices } = require('../src/grokVoices');
const { synthesizeGrokVoicePreview } = require('../src/voicePreview');

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
        signal: {
            cancelled: false,
            cancel(reason) {
                this.cancelled = true;
                this.reason = reason;
            },
        },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        onSessionEvent: (event) => events.push(event),
        log: () => {},
    };
}

test('Grok session config keeps PTT audio explicit and maps Wine tools', () => {
    const config = buildGrokSessionConfig({
        systemInstructionText: 'Wine expert',
        voiceName: 'rex',
        contentToolsEnabled: true,
        toolDeclarations: [{
            name: 'search_wine_knowledge',
            description: 'Search Wine AI knowledge',
            parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } } },
        }],
    }, { voiceId: 'eve' });

    assert.equal(config.voice, 'rex');
    assert.equal(config.turn_detection, null);
    assert.equal(config.audio.input.format.rate, 16000);
    assert.equal(config.audio.output.format.rate, 24000);
    assert.deepEqual(config.tools[0], {
        type: 'function',
        name: 'search_wine_knowledge',
        description: 'Search Wine AI knowledge',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
    });
});

test('Grok provider streams audio, normalizes cumulative transcripts, and continues after tools', async () => {
    const socket = new FakeSocket();
    const provider = new GrokVoiceProvider({
        apiKey: 'test-key',
        voiceId: 'rex',
        webSocketFactory: () => {
            queueMicrotask(() => socket.emit('open'));
            return socket;
        },
    });
    const session = provider.createSession({
        systemInstructionText: 'Wine expert',
        contentToolsEnabled: true,
        toolDeclarations: [{
            name: 'search_wine_knowledge',
            description: 'Search',
            parameters: { type: 'object', properties: {} },
        }],
        toolHandlers: {
            search_wine_knowledge: async ({ args }) => ({ answer: `found:${args.query}` }),
        },
    });
    const events = [];
    const audioChunks = [];
    const context = createContext(events, audioChunks);

    session.beginResponse(context);
    await session.connect();
    session.sendAudio(Buffer.from([1, 0, 2, 0]));
    await session.endInput(context);

    session.handleMessage(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.updated',
        transcript: 'Ce vin',
    }));
    session.handleMessage(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.updated',
        transcript: 'Ce vin recomanzi?',
    }));
    session.handleMessage(JSON.stringify({
        type: 'response.output_audio.delta',
        delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
    }));
    session.handleMessage(JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_1',
        name: 'search_wine_knowledge',
        arguments: JSON.stringify({ query: 'Feteasca Neagra' }),
    }));
    session.handleMessage(JSON.stringify({ type: 'response.done' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(events.filter((event) => event.type === 'audio.start').length, 1);
    assert.equal(audioChunks.length, 1);
    assert.deepEqual(
        events.filter((event) => event.type === 'transcript.user').map((event) => event.text),
        ['Ce vin', ' recomanzi?'],
    );
    assert.equal(events.some((event) => event.type === 'tool.call'), true);
    assert.equal(events.some((event) => event.type === 'tool.response'), true);
    assert.equal(events.some((event) => event.type === 'audio.end'), false);
    assert.equal(socket.sent.some((payload) => payload.item?.type === 'function_call_output'), true);
    assert.equal(socket.sent.at(-1).type, 'response.create');

    session.handleMessage(JSON.stringify({ type: 'response.done' }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => event.type === 'audio.end'), true);
});

test('provider registry exposes configured providers and rejects missing keys', () => {
    const registry = createRealtimeProviderRegistry({
        defaultProvider: 'gemini',
        geminiApiKey: 'gemini-test',
        grokApiKey: '',
    }, {}, {
        gemini: { createSession: () => ({ name: 'gemini' }) },
    });

    assert.equal(registry.resolveDefault().id, 'gemini');
    assert.equal(registry.list().find((item) => item.id === 'gemini').configured, true);
    assert.equal(registry.list().find((item) => item.id === 'grok').configured, false);
    assert.throws(() => registry.resolve('grok'), { code: 'realtime_provider_not_configured' });
});

test('Grok voice catalog refresh and MP3 preview use server-side authorization', async () => {
    const calls = [];
    const voices = await listGrokVoices({
        apiKey: 'test-key',
        force: true,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                json: async () => ({ voices: [{ voice_id: 'rex', name: 'Rex', language: 'multilingual' }] }),
            };
        },
    });
    assert.equal(voices[0].id, 'rex');
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');

    const preview = await synthesizeGrokVoicePreview({
        apiKey: 'test-key',
        voiceName: 'rex',
        text: 'Salut',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                headers: { get: () => 'audio/mpeg' },
                arrayBuffer: async () => Uint8Array.from([73, 68, 51]).buffer,
            };
        },
    });
    assert.equal(preview.voiceName, 'rex');
    assert.equal(preview.mimeType, 'audio/mpeg');
    assert.equal(Buffer.from(preview.audioBase64, 'base64').toString('ascii'), 'ID3');
    assert.equal(calls[1].options.headers.authorization, 'Bearer test-key');
});

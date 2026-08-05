'use strict';

const {
    ClassicVoiceProvider,
    pcm16ToWav,
    getTranscript,
} = require('../src/realtime/classicVoiceProvider');
const { normalizeProviderName, createRealtimeProviderRegistry } = require('../src/realtime/providerRegistry');
const t = require('./helpers/assertions');

function asyncChunks(items) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) yield item;
        },
    };
}

async function run() {
    const wav = pcm16ToWav(Buffer.from([1, 2, 3, 4]));
    t.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    t.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    t.equal(wav.readUInt32LE(40), 4);
    t.equal(wav.length, 48);

    t.equal(getTranscript({ results: { channels: [{ alternatives: [{ transcript: '  привет  ' }] }] } }), 'привет');
    t.equal(normalizeProviderName('stt-llm-tts'), 'classic');
    t.equal(normalizeProviderName('cascade'), 'classic');

    const sttRequests = [];
    const fetchImpl = async (url, options) => {
        sttRequests.push({ url, options });
        return {
            ok: true,
            async json() {
                return {
                    metadata: { detected_language: 'ru' },
                    results: { channels: [{ alternatives: [{ transcript: 'Какое вино к баранине?' }] }] },
                };
            },
        };
    };

    const llmCalls = [];
    const ai = {
        models: {
            async generateContent(request) {
                llmCalls.push(request);
                return { text: 'К баранине подойдёт Fetească Neagră.' };
            },
            async generateContentStream(request) {
                llmCalls.push(request);
                return asyncChunks([
                    {
                        candidates: [{
                            content: {
                                parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }],
                            },
                        }],
                    },
                ]);
            },
        },
    };

    const provider = new ClassicVoiceProvider({
        deepgramApiKey: 'dg-test',
        geminiApiKey: 'gemini-test',
        llmModel: 'llm-test',
        ttsModel: 'tts-test',
        ttsVoice: 'Kore',
    }, {
        fetchImpl,
        aiFactory: () => ai,
    });
    const session = provider.createSession({
        systemInstructionText: 'Ты цифровой сомелье.',
        toolDeclarations: [],
        toolHandlers: {},
        voiceName: 'Puck',
    });
    await session.connect(() => {});
    session.sendAudio(Buffer.from([1, 0, 2, 0]));

    const events = [];
    const audioChunks = [];
    await session.endInput({
        responseId: 'response_1',
        turnId: 'turn_1',
        signal: { cancelled: false },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        log: () => {},
    });

    t.equal(sttRequests.length, 1);
    t.match(sttRequests[0].url, /api\.deepgram\.com\/v1\/listen/);
    t.equal(sttRequests[0].options.headers.Authorization, 'Token dg-test');
    t.ok(events.some((event) => event.type === 'transcript.user' && event.text === 'Какое вино к баранине?'));
    t.ok(events.some((event) => event.type === 'transcript.model' && /Fetească Neagră/.test(event.text)));
    t.ok(events.some((event) => event.type === 'audio.start'));
    t.ok(events.some((event) => event.type === 'audio.end'));
    t.equal(audioChunks.length, 1);
    t.equal(Buffer.from(audioChunks[0].audio_base64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
    t.equal(llmCalls[0].model, 'llm-test');
    t.equal(llmCalls[1].model, 'tts-test');
    t.equal(llmCalls[1].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');

    const registry = createRealtimeProviderRegistry({
        defaultProvider: 'classic',
    }, {}, {
        classic: provider,
    });
    const resolved = registry.resolve('classic');
    t.equal(resolved.id, 'classic');
    t.equal(resolved.metadata.provider, 'classic');
    const listed = registry.list();
    t.ok(listed.some((item) => item.id === 'classic'));

    const cancelledSignal = { cancelled: false };
    session.activeSignal = cancelledSignal;
    session.interrupt('barge_in');
    t.equal(cancelledSignal.cancelled, true);
    t.equal(cancelledSignal.reason, 'barge_in');
    session.close();
}

module.exports = { run };

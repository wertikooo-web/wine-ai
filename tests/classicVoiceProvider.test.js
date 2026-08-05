'use strict';

const {
    ClassicVoiceProvider,
    pcm16ToWav,
} = require('../src/realtime/classicVoiceProvider');
const {
    createWhisperAdapter,
    normalizeDetectedLanguage,
} = require('../src/realtime/classicSttAdapters');
const { normalizeProviderName, normalizeClassicSttProvider, createRealtimeProviderRegistry } = require('../src/realtime/providerRegistry');
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
    t.equal(normalizeDetectedLanguage('Russian'), 'ru-RU');
    t.equal(normalizeDetectedLanguage('ro'), 'ro-RO');
    t.equal(normalizeProviderName('stt-llm-tts'), 'classic');
    t.equal(normalizeClassicSttProvider('anything'), 'whisper');
    t.equal(normalizeClassicSttProvider('deepgram'), 'deepgram');

    const whisperRequests = [];
    const whisper = createWhisperAdapter({ openaiApiKey: 'openai-test', sttModel: 'whisper-1' }, {
        fetchImpl: async (url, options) => {
            whisperRequests.push({ url, options });
            return {
                ok: true,
                async json() { return { text: 'Какое вино к баранине?', language: 'russian' }; },
            };
        },
    });
    const whisperResult = await whisper.transcribe(Buffer.alloc(7000), { language: 'ru-RU' });
    t.equal(whisperRequests.length, 1);
    t.equal(whisperRequests[0].url, 'https://api.openai.com/v1/audio/transcriptions');
    t.equal(whisperResult.text, 'Какое вино к баранине?');
    t.equal(whisperResult.language, 'ru-RU');

    const ai = {
        models: {
            async generateContent() {
                return { text: 'К баранине подойдёт Fetească Neagră.' };
            },
            async generateContentStream() {
                return asyncChunks([{ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }]);
            },
        },
    };

    const provider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: () => ai,
        sttFactory: () => ({
            id: 'whisper', model: 'whisper-1', configured: true,
            async transcribe() { return { text: 'Какое вино к баранине?', language: 'ru-RU' }; },
        }),
    });
    const session = provider.createSession({ systemInstructionText: 'Ты цифровой сомелье.', voiceName: 'Puck' });
    await session.connect(() => {});
    session.sendAudio(Buffer.alloc(7000));

    const events = [];
    const audioChunks = [];
    await session.endInput({
        responseId: 'response_1', turnId: 'turn_1', signal: { cancelled: false },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        log: () => {},
    });

    t.ok(events.some((event) => event.type === 'transcript.user'));
    t.ok(events.some((event) => event.type === 'transcript.model' && /Fetească Neagră/.test(event.text)));
    t.ok(events.some((event) => event.type === 'audio.start'));
    t.ok(events.some((event) => event.type === 'audio.end'));
    t.equal(audioChunks.length, 1);

    const registry = createRealtimeProviderRegistry({ defaultProvider: 'classic' }, {}, { classic: provider });
    const resolved = registry.resolve('classic');
    t.equal(resolved.id, 'classic');
    t.equal(resolved.metadata.provider, 'classic');

    const cancelledSignal = { cancelled: false };
    session.activeSignal = cancelledSignal;
    session.interrupt('barge_in');
    t.equal(cancelledSignal.cancelled, true);
    session.close();
}

module.exports = { run };

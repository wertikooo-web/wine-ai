'use strict';

const {
    ClassicVoiceProvider,
    pcm16ToWav,
} = require('../src/realtime/classicVoiceProvider');
const {
    createWhisperAdapter,
    normalizeDetectedLanguage,
} = require('../src/realtime/classicSttAdapters');
const { normalizeLanguage } = require('../src/realtime/classicTtsRouter');
const { normalizeProviderName, normalizeClassicSttProvider, createRealtimeProviderRegistry } = require('../src/realtime/providerRegistry');
const t = require('./helpers/assertions');

function asyncChunks(items) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) yield item;
        },
    };
}

function createContext(events, audioChunks, logs, suffix = '1') {
    return {
        generationId: `gen_${suffix}`,
        responseId: `response_${suffix}`,
        turnId: `turn_${suffix}`,
        signal: { cancelled: false },
        onEvent: (event) => events.push(event),
        onAudioChunk: (event) => audioChunks.push(event),
        log: (type, payload) => logs.push({ type, payload }),
    };
}

async function run() {
    const wav = pcm16ToWav(Buffer.from([1, 2, 3, 4]));
    t.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    t.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    t.equal(wav.readUInt32LE(40), 4);
    t.equal(normalizeDetectedLanguage('Russian'), 'ru-RU');
    t.equal(normalizeDetectedLanguage('ro'), 'ro-RO');
    t.equal(normalizeLanguage('ru-RU', ''), 'ru');
    t.equal(normalizeLanguage('auto', 'Ce vin recomanzi?'), 'en');
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

    let geminiTtsCalls = 0;
    const ai = {
        models: {
            async generateContent() {
                return { text: 'К баранине подойдёт Fetească Neagră.' };
            },
            async generateContentStream() {
                geminiTtsCalls += 1;
                return asyncChunks([{ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }]);
            },
        },
    };

    const yandexCalls = [];
    const provider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: () => ai,
        sttFactory: () => ({
            id: 'whisper', model: 'whisper-1', configured: true,
            async transcribe() { return { text: 'Какое вино к баранине?', language: 'ru-RU' }; },
        }),
        ttsFactory: () => ({
            yandexConfigured: true,
            chooseProvider(language) { return language === 'ru' ? 'yandex' : 'gemini'; },
            async synthesizeRussian(text, options) {
                yandexCalls.push({ text, options });
                return { provider: 'yandex', language: 'ru', sampleRate: 16000, pcm: Buffer.from([0, 0, 1, 0]) };
            },
        }),
    });
    const session = provider.createSession({ systemInstructionText: 'Ты цифровой сомелье.', voiceName: 'Puck' });
    await session.connect(() => {});
    session.sendAudio(Buffer.alloc(7000));

    const events = [];
    const audioChunks = [];
    const logs = [];
    await session.endInput(createContext(events, audioChunks, logs));

    t.ok(events.some((event) => event.type === 'transcript.user'));
    t.ok(events.some((event) => event.type === 'transcript.model' && /Fetească Neagră/.test(event.text)));
    t.ok(events.some((event) => event.type === 'audio.start' && event.tts_provider === 'yandex'));
    t.ok(events.some((event) => event.type === 'audio.end' && event.tts_provider === 'yandex'));
    t.equal(audioChunks.length, 1);
    t.equal(audioChunks[0].tts_provider, 'yandex');
    t.equal(yandexCalls.length, 1);
    t.equal(geminiTtsCalls, 0);

    const fallbackProvider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: () => ai,
        sttFactory: () => ({ id: 'whisper', model: 'whisper-1', configured: true, async transcribe() { return { text: '', language: 'ru-RU' }; } }),
        ttsFactory: () => ({
            yandexConfigured: true,
            chooseProvider() { return 'yandex'; },
            async synthesizeRussian() { throw Object.assign(new Error('boom'), { code: 'classic_yandex_tts_failed' }); },
        }),
    });
    const fallbackSession = fallbackProvider.createSession({ voiceName: 'Puck' });
    await fallbackSession.connect(() => {});
    const fallbackEvents = [];
    const fallbackChunks = [];
    const fallbackLogs = [];
    await fallbackSession.sendText('Привет', createContext(fallbackEvents, fallbackChunks, fallbackLogs, 'fallback'));
    t.ok(fallbackLogs.some((entry) => entry.type === 'classic_tts_fallback'));
    t.ok(fallbackEvents.some((event) => event.type === 'audio.start' && event.tts_provider === 'gemini'));
    t.equal(fallbackChunks[0].tts_provider, 'gemini');
    t.equal(geminiTtsCalls, 1);

    const registry = createRealtimeProviderRegistry({ defaultProvider: 'classic' }, {}, { classic: provider });
    const resolved = registry.resolve('classic');
    t.equal(resolved.id, 'classic');
    t.equal(resolved.metadata.provider, 'classic');
    t.deepEqual(registry.get('classic').supported_voice_modes, ['hold_to_talk']);
    t.deepEqual(registry.get('gemini').supported_voice_modes, ['hold_to_talk', 'tap_to_start']);

    const toolRounds = [];
    const toolProvider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: (apiKey) => ({
            models: {
                async generateContent({ contents }) {
                    const hasFunctionResponses = Array.isArray(contents)
                        && contents.some((c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse));
                    if (!hasFunctionResponses) {
                        return { functionCalls: [{ name: 'search_wine_knowledge', args: { query: 'Cricova' } }] };
                    }
                    return { text: 'Cricova — старейший подвал Молдовы.' };
                },
                async generateContentStream() {
                    return asyncChunks([{ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }]);
                },
            },
        }),
        sttFactory: () => ({ id: 'whisper', model: 'whisper-1', configured: true, async transcribe() { return { text: 'Что ты знаешь про Cricova?', language: 'en' }; } }),
        ttsFactory: () => ({
            yandexConfigured: true,
            chooseProvider() { return 'gemini'; },
            async synthesizeRussian() { throw new Error('no_yandex'); },
        }),
    });
    const toolSession = toolProvider.createSession({
        toolDeclarations: [{ name: 'search_wine_knowledge' }],
        toolHandlers: {
            search_wine_knowledge: async (toolCall) => {
                toolRounds.push(toolCall);
                return { results: [{ wine: 'Cricova' }] };
            },
        },
    });
    await toolSession.connect(() => {});
    const toolEvents = [];
    const toolChunks = [];
    const toolLogs = [];
    await toolSession.sendText('Что ты знаешь про Cricova?', createContext(toolEvents, toolChunks, toolLogs, 'tool'));

    t.equal(toolRounds.length, 1);
    t.equal(toolRounds[0].args.query, 'Cricova');
    t.equal(toolRounds[0].generationId, 'response_tool');
    t.equal(toolRounds[0].turnId, 'turn_tool');
    t.equal(toolRounds[0].providerInstanceId, 'classic_session_1');
    t.ok(toolEvents.some((event) => event.type === 'tool.call' && event.tool_name === 'search_wine_knowledge'));
    t.ok(toolEvents.some((event) => event.type === 'transcript.model' && /Cricova — старейший подвал/.test(event.text)));

    // --- Bound Tool Regression Tests ---
    const { bindTool } = require('../src/tools/toolHelpers');

    // Test 1: Real bindTool wrapper regression test
    const logEvents = [];
    const regressionToolContext = {
        log: (event, details) => {
            logEvents.push({ event, details });
        },
    };

    let lastReceivedArgs = null;
    const testToolImpl = async (args) => {
        lastReceivedArgs = args;
        return { success: true, count: 42 };
    };

    const boundRegressionTool = bindTool({
        name: 'regression_test_tool',
        impl: testToolImpl,
    }, regressionToolContext);

    let capturedFunctionResponse = null;
    const regressionProvider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: () => ({
            models: {
                async generateContent({ contents }) {
                    const hasFunctionResponses = Array.isArray(contents)
                        && contents.some((c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse));
                    if (!hasFunctionResponses) {
                        return { functionCalls: [{ name: 'regression_test_tool', args: { query: 'Feteasca' } }] };
                    }
                    // Capture the functionResponse returned from the engine
                    const responsePart = contents.find((c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse));
                    capturedFunctionResponse = responsePart.parts.find((p) => p.functionResponse).functionResponse;
                    return { text: 'Done.' };
                },
                async generateContentStream() {
                    return asyncChunks([{ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }]);
                },
            },
        }),
        sttFactory: () => ({ id: 'whisper', model: 'whisper-1', configured: true, async transcribe() { return { text: 'Call tool', language: 'en' }; } }),
        ttsFactory: () => ({
            yandexConfigured: true,
            chooseProvider() { return 'gemini'; },
            async synthesizeRussian() { throw new Error('no_yandex'); },
        }),
    });

    const regressionSession = regressionProvider.createSession({
        toolDeclarations: [{ name: 'regression_test_tool' }],
        toolHandlers: {
            regression_test_tool: boundRegressionTool,
        },
    });

    await regressionSession.connect(() => {});
    const rEvents = [];
    const rChunks = [];
    const rLogs = [];
    const regressionContext = createContext(rEvents, rChunks, rLogs, 'regression');

    await regressionSession.sendText('Call tool', regressionContext);

    // Assert 1: A tool is registered and matched
    t.ok(capturedFunctionResponse);
    t.equal(capturedFunctionResponse.name, 'regression_test_tool');

    // Assert 2: Non-empty tool arguments reach the underlying handler unchanged
    t.deepEqual(lastReceivedArgs, { query: 'Feteasca' });

    // Find the log event to verify IDs
    const executionLog = logEvents.find((e) => e.event === 'tool_executed');
    t.ok(executionLog);

    // Assert 3: generationId equals context.responseId and turnId equals context.turnId
    t.equal(executionLog.details.generationId, regressionContext.responseId); // 'response_regression'
    t.equal(executionLog.details.turnId, regressionContext.turnId); // 'turn_regression'

    // Assert 4: The tool result is normalized and returned to the model
    // (This also proves the test would fail under the old handler(call.args || {}) implementation,
    // which would reject with 'missing_generation_id' and return that in the response).
    t.deepEqual(capturedFunctionResponse.response, { success: true, count: 42 });

    // Test 2: Edge-case coverage for missing call.args
    let edgeCaseArgs = null;
    const edgeCaseImpl = async (args) => {
        edgeCaseArgs = args;
        return { ok: true };
    };

    const boundEdgeCaseTool = bindTool({
        name: 'edge_case_tool',
        impl: edgeCaseImpl,
    }, regressionToolContext);

    let capturedEdgeCaseResponse = null;
    const edgeCaseProvider = new ClassicVoiceProvider({ geminiApiKey: 'gemini-test' }, {
        aiFactory: () => ({
            models: {
                async generateContent({ contents }) {
                    const hasFunctionResponses = Array.isArray(contents)
                        && contents.some((c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse));
                    if (!hasFunctionResponses) {
                        return { functionCalls: [{ name: 'edge_case_tool' }] }; // args missing entirely
                    }
                    const responsePart = contents.find((c) => Array.isArray(c.parts) && c.parts.some((p) => p.functionResponse));
                    capturedEdgeCaseResponse = responsePart.parts.find((p) => p.functionResponse).functionResponse;
                    return { text: 'Done.' };
                },
                async generateContentStream() {
                    return asyncChunks([{ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([0, 0, 1, 0]).toString('base64') } }] } }] }]);
                },
            },
        }),
        sttFactory: () => ({ id: 'whisper', model: 'whisper-1', configured: true, async transcribe() { return { text: 'Call tool', language: 'en' }; } }),
        ttsFactory: () => ({
            yandexConfigured: true,
            chooseProvider() { return 'gemini'; },
            async synthesizeRussian() { throw new Error('no_yandex'); },
        }),
    });

    const edgeCaseSession = edgeCaseProvider.createSession({
        toolDeclarations: [{ name: 'edge_case_tool' }],
        toolHandlers: {
            edge_case_tool: boundEdgeCaseTool,
        },
    });

    await edgeCaseSession.connect(() => {});
    const ecEvents = [];
    const ecChunks = [];
    const ecLogs = [];
    const edgeCaseContext = createContext(ecEvents, ecChunks, ecLogs, 'edgecase');

    await edgeCaseSession.sendText('Call tool', edgeCaseContext);

    // Assert 5: Missing call.args results in args: {} passed to underlying handler
    t.deepEqual(edgeCaseArgs, {});
    t.deepEqual(capturedEdgeCaseResponse.response, { ok: true });

    const cancelledSignal = { cancelled: false };
    session.activeSignal = cancelledSignal;
    session.interrupt('barge_in');
    t.equal(cancelledSignal.cancelled, true);
    session.close();
    fallbackSession.close();
}

module.exports = { run };

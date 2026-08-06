'use strict';

const { GoogleGenAI } = require('@google/genai');
const {
    createClassicSttAdapter,
    DEFAULT_STT_PROVIDER,
    DEFAULT_WHISPER_MODEL,
} = require('./classicSttAdapters');
const { ClassicTtsRouter, normalizeLanguage } = require('./classicTtsRouter');

const DEFAULT_CLASSIC_LLM_MODEL = process.env.CLASSIC_LLM_MODEL || 'gemini-3.1-flash-lite';
const DEFAULT_CLASSIC_TTS_MODEL = process.env.CLASSIC_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
const DEFAULT_CLASSIC_TTS_VOICE = process.env.CLASSIC_TTS_VOICE || 'Kore';
const DEFAULT_CLASSIC_STT_MODEL = process.env.CLASSIC_STT_MODEL || DEFAULT_WHISPER_MODEL;
const CLASSIC_INPUT_SAMPLE_RATE = 16000;
const CLASSIC_OUTPUT_SAMPLE_RATE = 24000;
const MAX_INPUT_BYTES = Number(process.env.CLASSIC_MAX_INPUT_BYTES || 8 * 1024 * 1024);
const MAX_TOOL_ROUNDS = Number(process.env.CLASSIC_MAX_TOOL_ROUNDS || 4);

function pcm16ToWav(pcm, sampleRate = CLASSIC_OUTPUT_SAMPLE_RATE) {
    const payload = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    const wav = Buffer.allocUnsafe(44 + payload.length);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + payload.length, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(payload.length, 40);
    payload.copy(wav, 44);
    return wav;
}

function normalizeToolResult(result) {
    if (result === undefined) return { ok: true };
    if (result && typeof result === 'object') return result;
    return { result };
}

class ClassicVoiceProvider {
    constructor(config = {}, dependencies = {}) {
        this.name = 'classic';
        this.config = {
            sttProvider: config.sttProvider || process.env.CLASSIC_STT_PROVIDER || DEFAULT_STT_PROVIDER,
            sttModel: config.sttModel || DEFAULT_CLASSIC_STT_MODEL,
            openaiApiKey: config.openaiApiKey || process.env.OPENAI_API_KEY || '',
            deepgramApiKey: config.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '',
            geminiApiKey: config.geminiApiKey || process.env.GEMINI_API_KEY || '',
            llmModel: config.llmModel || DEFAULT_CLASSIC_LLM_MODEL,
            ttsModel: config.ttsModel || DEFAULT_CLASSIC_TTS_MODEL,
            ttsVoice: config.ttsVoice || DEFAULT_CLASSIC_TTS_VOICE,
            yandexApiKey: config.yandexApiKey || process.env.YANDEX_API_KEY || '',
            yandexFolderId: config.yandexFolderId || process.env.YANDEX_FOLDER_ID || '',
            yandexVoiceRu: config.yandexVoiceRu || process.env.CLASSIC_YANDEX_VOICE_RU || 'alena',
            yandexSpeed: Number(config.yandexSpeed || process.env.CLASSIC_YANDEX_SPEED || 0.9),
        };
        this.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
        this.aiFactory = dependencies.aiFactory || ((apiKey) => new GoogleGenAI({ apiKey }));
        this.sttFactory = dependencies.sttFactory || ((cfg) => createClassicSttAdapter(cfg, { fetchImpl: this.fetchImpl }));
        this.ttsFactory = dependencies.ttsFactory || ((cfg) => new ClassicTtsRouter(cfg, { fetchImpl: this.fetchImpl }));
        this.instanceCounter = 0;
    }

    createSession(options = {}) {
        this.instanceCounter += 1;
        return new ClassicVoiceProviderSession({
            config: this.config,
            stt: this.sttFactory(this.config),
            ttsRouter: this.ttsFactory(this.config),
            ai: this.aiFactory(this.config.geminiApiKey),
            instanceId: `classic_session_${this.instanceCounter}`,
            options,
        });
    }
}

class ClassicVoiceProviderSession {
    constructor({ config, stt, ttsRouter, ai, instanceId, options }) {
        this.name = 'classic';
        this.config = config;
        this.stt = stt;
        this.ttsRouter = ttsRouter;
        this.ai = ai;
        this.instanceId = instanceId;
        this.systemInstructionText = options.systemInstructionText || '';
        this.toolDeclarations = Array.isArray(options.toolDeclarations) ? options.toolDeclarations : [];
        this.toolHandlers = options.toolHandlers && typeof options.toolHandlers === 'object' ? options.toolHandlers : {};
        this.voiceName = options.voiceName || options.voice || config.ttsVoice;
        this.language = options.language || 'auto';
        this.history = [];
        this.inputChunks = [];
        this.inputBytes = 0;
        this.closed = false;
        this.activeSignal = null;
        this.activeAbortController = null;
        this.rotateOnInterrupt = false;
        this.rotateAfterOutputComplete = false;
    }

    async connect(log) {
        if (!this.stt?.configured) throw Object.assign(new Error('classic_stt_api_key_missing'), { code: 'classic_stt_api_key_missing' });
        if (!this.config.geminiApiKey) throw new Error('classic_gemini_api_key_missing');
        if (typeof log === 'function') {
            log('classic_provider_connected', {
                providerInstanceId: this.instanceId,
                sttProvider: this.stt.id,
                sttModel: this.stt.model,
                llmModel: this.config.llmModel,
                ttsModel: this.config.ttsModel,
                yandexConfigured: Boolean(this.ttsRouter?.yandexConfigured),
            });
        }
    }

    sendAudio(buffer) {
        if (this.closed || !buffer?.length) return;
        const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        if (this.inputBytes + chunk.length > MAX_INPUT_BYTES) {
            throw Object.assign(new Error('classic_input_too_large'), { code: 'classic_input_too_large' });
        }
        this.inputChunks.push(chunk);
        this.inputBytes += chunk.length;
    }

    beginResponse() {}

    interrupt(reason = 'interrupt') {
        if (this.activeSignal && !this.activeSignal.cancelled) {
            this.activeSignal.cancelled = true;
            this.activeSignal.reason = reason;
            this.activeSignal.cancelledAt = Date.now();
        }
        if (this.activeAbortController) {
            this.activeAbortController.abort(reason);
            this.activeAbortController = null;
        }
        this.inputChunks = [];
        this.inputBytes = 0;
    }

    close() {
        this.closed = true;
        this.interrupt('close');
        this.history = [];
    }

    async transcribeAudio(audio, signal) {
        return this.stt.transcribe(audio, {
            signal,
            language: this.language,
            onController: (controller) => { this.activeAbortController = controller; },
        });
    }

    async generateReply(userText, signal, log, context = {}) {
        const contents = [...this.history, { role: 'user', parts: [{ text: userText }] }];
        const generationId = context.generationId || null;
        const responseId = context.responseId || null;
        const turnId = context.turnId || null;
        const onEvent = context.onEvent || (() => {});
        const config = { systemInstruction: this.systemInstructionText || undefined };
        if (this.toolDeclarations.length) config.tools = [{ functionDeclarations: this.toolDeclarations }];

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
            if (this.closed || signal.cancelled) return '';
            const response = await this.ai.models.generateContent({ model: this.config.llmModel, contents, config });
            if (this.closed || signal.cancelled) return '';
            const modelContent = response?.candidates?.[0]?.content;
            if (modelContent) contents.push(modelContent);
            const calls = Array.isArray(response?.functionCalls) ? response.functionCalls : [];
            if (!calls.length) {
                const answer = String(response?.text || '').trim();
                if (answer) {
                    this.history = contents.slice(-12);
                    if (!modelContent) this.history.push({ role: 'model', parts: [{ text: answer }] });
                }
                return answer;
            }
            if (round === MAX_TOOL_ROUNDS) throw new Error('classic_tool_round_limit');

            const responseParts = [];
            for (const call of calls) {
                if (this.closed || signal.cancelled) return '';
                const handler = this.toolHandlers[call.name];
                let result;
                onEvent({
                    type: 'tool.call',
                    response_id: responseId,
                    turn_id: turnId,
                    tool_name: String(call.name || ''),
                    provider_instance_id: this.instanceId,
                });
                if (typeof handler !== 'function') {
                    result = { ok: false, error: 'tool_not_available', tool: call.name };
                } else {
                    try {
                        result = normalizeToolResult(await handler({
                            args: call.args || {},
                            functionCall: call,
                            generationId,
                            responseId,
                            turnId,
                            providerInstanceId: this.instanceId,
                        }));
                    } catch (error) {
                        result = { ok: false, error: error?.code || error?.message || 'tool_failed' };
                    }
                }
                log('classic_tool_completed', { tool: call.name, ok: result?.ok !== false });
                responseParts.push({ functionResponse: { name: call.name, response: result } });
            }
            contents.push({ role: 'user', parts: responseParts });
        }
        return '';
    }

    emitAudioBuffer(pcm, sampleRate, context, provider, startedAt) {
        const { responseId, turnId, signal, onEvent, onAudioChunk, log } = context;
        if (this.closed || signal.cancelled || !pcm?.length) return false;
        onEvent({
            type: 'audio.start',
            response_id: responseId,
            turn_id: turnId,
            elapsed_ms: Date.now() - startedAt,
            format: 'audio/wav',
            provider_instance_id: this.instanceId,
            tts_provider: provider,
        });
        log('audio_start', { responseId, turnId, elapsedMs: Date.now() - startedAt, ttsProvider: provider });
        onAudioChunk({
            type: 'audio.chunk',
            response_id: responseId,
            turn_id: turnId,
            chunk_index: 0,
            mime_type: 'audio/wav',
            audio_base64: pcm16ToWav(pcm, sampleRate).toString('base64'),
            elapsed_ms: Date.now() - startedAt,
            tts_provider: provider,
        });
        if (this.closed || signal.cancelled) return false;
        onEvent({
            type: 'audio.end',
            response_id: responseId,
            turn_id: turnId,
            elapsed_ms: Date.now() - startedAt,
            tts_provider: provider,
        });
        log('audio_end', { responseId, turnId, elapsedMs: Date.now() - startedAt, chunkCount: 1, ttsProvider: provider });
        return true;
    }

    async streamGeminiSpeech(text, context, language, fallbackReason = null) {
        const { responseId, turnId, signal, onEvent, onAudioChunk, log } = context;
        const startedAt = Date.now();
        const stream = await this.ai.models.generateContentStream({
            model: this.config.ttsModel,
            contents: [{ parts: [{ text: `Synthesize this sommelier answer exactly as written. Keep language, wine names and numbers unchanged.\n${text}` }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voiceName || this.config.ttsVoice } } },
            },
        });

        let chunkIndex = 0;
        let audioStarted = false;
        for await (const chunk of stream) {
            if (this.closed || signal.cancelled) return;
            const parts = chunk?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
                if (this.closed || signal.cancelled) return;
                const base64 = part?.inlineData?.data;
                if (!base64) continue;
                const pcm = Buffer.from(base64, 'base64');
                if (!pcm.length) continue;
                if (!audioStarted) {
                    audioStarted = true;
                    onEvent({
                        type: 'audio.start',
                        response_id: responseId,
                        turn_id: turnId,
                        elapsed_ms: Date.now() - startedAt,
                        format: 'audio/wav',
                        provider_instance_id: this.instanceId,
                        tts_provider: 'gemini',
                        tts_fallback_reason: fallbackReason || undefined,
                    });
                    log('audio_start', { responseId, turnId, elapsedMs: Date.now() - startedAt, ttsProvider: 'gemini', language, fallbackReason });
                }
                onAudioChunk({
                    type: 'audio.chunk',
                    response_id: responseId,
                    turn_id: turnId,
                    chunk_index: chunkIndex,
                    mime_type: 'audio/wav',
                    audio_base64: pcm16ToWav(pcm).toString('base64'),
                    elapsed_ms: Date.now() - startedAt,
                    tts_provider: 'gemini',
                });
                chunkIndex += 1;
            }
        }
        if (this.closed || signal.cancelled) return;
        if (!audioStarted) throw new Error('classic_tts_empty_audio');
        onEvent({ type: 'audio.end', response_id: responseId, turn_id: turnId, elapsed_ms: Date.now() - startedAt, tts_provider: 'gemini' });
        log('audio_end', { responseId, turnId, elapsedMs: Date.now() - startedAt, chunkCount: chunkIndex, ttsProvider: 'gemini' });
    }

    async streamSpeech(text, context, detectedLanguage = null) {
        const { signal, log } = context;
        const language = normalizeLanguage(detectedLanguage || this.language, text);
        const selectedProvider = this.ttsRouter.chooseProvider(language, text);
        log('classic_tts_route_selected', { language, provider: selectedProvider });

        if (selectedProvider === 'yandex') {
            const startedAt = Date.now();
            const controller = new AbortController();
            this.activeAbortController = controller;
            if (signal.cancelled) controller.abort(signal.reason || 'cancelled');
            try {
                const result = await this.ttsRouter.synthesizeRussian(text, {
                    signal: controller.signal,
                    voice: this.config.yandexVoiceRu,
                    speed: this.config.yandexSpeed,
                });
                this.activeAbortController = null;
                if (this.closed || signal.cancelled) return;
                this.emitAudioBuffer(result.pcm, result.sampleRate, context, 'yandex', startedAt);
                return;
            } catch (error) {
                this.activeAbortController = null;
                if (this.closed || signal.cancelled || error?.name === 'AbortError') return;
                log('classic_tts_fallback', {
                    from: 'yandex',
                    to: 'gemini',
                    language,
                    error: error?.code || error?.message || 'unknown',
                });
                await this.streamGeminiSpeech(text, context, language, error?.code || error?.message || 'yandex_failed');
                return;
            }
        }

        await this.streamGeminiSpeech(text, context, language);
    }

    async answerText(userText, context, detectedLanguage = null) {
        const { responseId, turnId, signal, onEvent, log } = context;
        if (!userText || this.closed || signal.cancelled) return;
        onEvent({ type: 'transcript.user', response_id: responseId, turn_id: turnId, text: userText, language: detectedLanguage || undefined });
        log('response_processing_started', { responseId, turnId, providerInstanceId: this.instanceId, sttProvider: this.stt.id, sttModel: this.stt.model, llmModel: this.config.llmModel });
        const answer = await this.generateReply(userText, signal, log, context);
        if (!answer || this.closed || signal.cancelled) return;
        onEvent({ type: 'transcript.model', response_id: responseId, turn_id: turnId, text: answer });
        await this.streamSpeech(answer, context, detectedLanguage);
    }

    async endInput(context) {
        this.activeSignal = context.signal;
        const audio = Buffer.concat(this.inputChunks, this.inputBytes);
        this.inputChunks = [];
        this.inputBytes = 0;
        if (!audio.length || this.closed || context.signal.cancelled) return;
        try {
            const transcript = await this.transcribeAudio(audio, context.signal);
            await this.answerText(transcript.text, context, transcript.language);
        } finally {
            this.activeSignal = null;
            this.activeAbortController = null;
        }
    }

    async sendText(text, context) {
        this.activeSignal = context.signal;
        try {
            await this.answerText(String(text || '').trim(), context);
        } finally {
            this.activeSignal = null;
        }
    }
}

module.exports = {
    ClassicVoiceProvider,
    DEFAULT_CLASSIC_LLM_MODEL,
    DEFAULT_CLASSIC_TTS_MODEL,
    DEFAULT_CLASSIC_TTS_VOICE,
    DEFAULT_CLASSIC_STT_MODEL,
    DEFAULT_STT_PROVIDER,
    CLASSIC_INPUT_SAMPLE_RATE,
    CLASSIC_OUTPUT_SAMPLE_RATE,
    pcm16ToWav,
};

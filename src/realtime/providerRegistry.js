'use strict';

const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./geminiLiveProvider');
const { GrokVoiceProvider, DEFAULT_GROK_MODEL } = require('./grokVoiceProvider');
const {
    ClassicVoiceProvider,
    DEFAULT_CLASSIC_LLM_MODEL,
    DEFAULT_CLASSIC_TTS_MODEL,
    DEFAULT_CLASSIC_TTS_VOICE,
    DEFAULT_CLASSIC_STT_MODEL,
} = require('./classicVoiceProvider');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('../geminiVoices');
const { GROK_VOICES, DEFAULT_GROK_VOICE_ID, listGrokVoices } = require('../grokVoices');

function normalizeProviderName(value, fallback = 'mock') {
    const provider = String(value || '').trim().toLowerCase();
    if (provider === 'xai') return 'grok';
    if (provider === 'cascade' || provider === 'stt-llm-tts' || provider === 'stt_llm_tts') return 'classic';
    return ['mock', 'gemini', 'grok', 'classic'].includes(provider) ? provider : fallback;
}

function createRealtimeProviderRegistry(config = {}, commonMetadata = {}, overrides = {}) {
    const defaultProvider = normalizeProviderName(config.defaultProvider || process.env.REALTIME_PROVIDER || 'mock');
    const geminiKey = config.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
    const grokKey = config.grokApiKey ?? process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? '';
    const deepgramKey = config.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY ?? '';
    const mockProvider = overrides.mock || new MockRealtimeProvider(DEFAULT_CONFIG);
    const geminiProvider = overrides.gemini || new GeminiLiveProvider({
        apiKey: geminiKey,
        model: config.geminiModel,
        voiceName: config.geminiVoice,
    });
    const grokProvider = overrides.grok || new GrokVoiceProvider({
        apiKey: grokKey,
        model: config.grokModel,
        realtimeUrl: config.grokRealtimeUrl,
        voiceId: config.grokVoice,
    });
    const classicProvider = overrides.classic || new ClassicVoiceProvider({
        deepgramApiKey: deepgramKey,
        geminiApiKey: geminiKey,
        sttModel: config.classicSttModel,
        llmModel: config.classicLlmModel,
        ttsModel: config.classicTtsModel,
        ttsVoice: config.classicTtsVoice,
    });

    const definitions = {
        mock: {
            id: 'mock',
            label: 'Mock',
            configured: true,
            model: 'mock',
            defaultVoice: null,
            voices: [],
            provider: mockProvider,
            rotationMode: 'errors_only',
        },
        gemini: {
            id: 'gemini',
            label: 'Gemini Live',
            configured: Boolean(geminiKey || overrides.gemini),
            model: config.geminiModel || GEMINI_MODEL_ID,
            defaultVoice: config.geminiVoice || DEFAULT_VOICE_NAME || DEFAULT_GEMINI_LIVE_VOICE,
            voices: GEMINI_VOICES.map((voice) => ({
                id: voice.name,
                name: voice.name,
                characteristic: voice.characteristic,
            })),
            provider: geminiProvider,
            rotationMode: process.env.GEMINI_ROTATION_MODE || 'per_turn',
        },
        grok: {
            id: 'grok',
            label: 'Grok Voice',
            configured: Boolean(grokKey || overrides.grok),
            model: config.grokModel || DEFAULT_GROK_MODEL,
            defaultVoice: config.grokVoice || DEFAULT_GROK_VOICE_ID,
            voices: GROK_VOICES,
            provider: grokProvider,
            rotationMode: 'errors_only',
        },
        classic: {
            id: 'classic',
            label: 'Classic STT + LLM + TTS',
            configured: Boolean((deepgramKey && geminiKey) || overrides.classic),
            model: config.classicLlmModel || DEFAULT_CLASSIC_LLM_MODEL,
            defaultVoice: config.classicTtsVoice || DEFAULT_CLASSIC_TTS_VOICE,
            voices: GEMINI_VOICES.map((voice) => ({
                id: voice.name,
                name: voice.name,
                characteristic: voice.characteristic,
            })),
            provider: classicProvider,
            rotationMode: 'errors_only',
            sttModel: config.classicSttModel || DEFAULT_CLASSIC_STT_MODEL,
            ttsModel: config.classicTtsModel || DEFAULT_CLASSIC_TTS_MODEL,
        },
    };

    function publicDefinition(definition) {
        return {
            id: definition.id,
            label: definition.label,
            configured: definition.configured,
            model: definition.model,
            default_voice: definition.defaultVoice,
            voices: definition.voices,
            stt_model: definition.sttModel,
            tts_model: definition.ttsModel,
        };
    }

    function list() {
        return ['gemini', 'grok', 'classic']
            .map((id) => publicDefinition(definitions[id]));
    }

    function resolve(requestedProvider) {
        const id = normalizeProviderName(requestedProvider, defaultProvider);
        const definition = definitions[id];
        if (!definition) {
            throw Object.assign(new Error('realtime_provider_unknown'), { code: 'realtime_provider_unknown' });
        }
        if (!definition.configured) {
            throw Object.assign(new Error(`${id}_provider_not_configured`), {
                code: 'realtime_provider_not_configured',
                provider: id,
            });
        }
        return {
            id,
            metadata: {
                ...commonMetadata,
                provider: id,
                model: definition.model,
                sttModel: definition.sttModel,
                ttsModel: definition.ttsModel,
                defaultVoiceName: definition.defaultVoice || undefined,
                defaultVoiceConfigSource: definition.defaultVoice ? 'default' : 'provider_default',
                rotationMode: definition.rotationMode,
            },
            createSession: (sessionOptions = {}) => definition.provider.createSession(sessionOptions),
        };
    }

    function resolveDefault() {
        try {
            return resolve(defaultProvider);
        } catch {
            return resolve('mock');
        }
    }

    async function getPublicCapabilities() {
        const geminiDef = definitions.gemini;
        const grokDef = definitions.grok;
        const classicDef = definitions.classic;

        let grokVoicesList = [];
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 1500);
            grokVoicesList = await listGrokVoices({
                apiKey: grokKey,
                fetchImpl: (url, options) => globalThis.fetch(url, { ...options, signal: controller.signal })
            });
            clearTimeout(timeoutId);
        } catch (err) {
            console.warn('[WineAI] Failed to dynamically load grok voices in capabilities API:', err.message);
            grokVoicesList = [...GROK_VOICES];
        }

        return [
            {
                id: 'gemini',
                displayName: 'Gemini Live',
                configured: geminiDef.configured,
                unavailableReason: geminiDef.configured ? null : 'api_key_missing',
                supportsPerSessionModel: false,
                supportsPerSessionVoice: true,
                pipeline: 'native_speech_to_speech',
                models: [
                    {
                        id: geminiDef.model,
                        displayName: geminiDef.model,
                        voices: geminiDef.voices.map(v => ({
                            id: v.id,
                            displayName: v.name,
                            characteristic: v.characteristic
                        }))
                    }
                ]
            },
            {
                id: 'grok',
                displayName: 'Grok Voice',
                configured: grokDef.configured,
                unavailableReason: grokDef.configured ? null : 'api_key_missing',
                supportsPerSessionModel: false,
                supportsPerSessionVoice: true,
                pipeline: 'native_speech_to_speech',
                models: [
                    {
                        id: grokDef.model,
                        displayName: grokDef.model,
                        voices: grokVoicesList.map(v => ({
                            id: v.id,
                            displayName: v.name,
                            characteristic: v.characteristic
                        }))
                    }
                ]
            },
            {
                id: 'classic',
                displayName: 'Classic STT + LLM + TTS',
                configured: classicDef.configured,
                unavailableReason: classicDef.configured ? null : 'deepgram_or_gemini_api_key_missing',
                supportsPerSessionModel: false,
                supportsPerSessionVoice: true,
                pipeline: 'classic_stt_llm_tts',
                components: {
                    stt: classicDef.sttModel,
                    llm: classicDef.model,
                    tts: classicDef.ttsModel,
                },
                models: [
                    {
                        id: classicDef.model,
                        displayName: classicDef.model,
                        voices: classicDef.voices.map(v => ({
                            id: v.id,
                            displayName: v.name,
                            characteristic: v.characteristic
                        }))
                    }
                ]
            }
        ];
    }

    return {
        defaultProvider,
        list,
        resolve,
        resolveDefault,
        getPublicCapabilities,
        get: (providerId) => publicDefinition(definitions[normalizeProviderName(providerId, defaultProvider)]),
    };
}

module.exports = {
    createRealtimeProviderRegistry,
    normalizeProviderName,
};

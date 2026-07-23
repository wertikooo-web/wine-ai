'use strict';

const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./mockRealtimeProvider');
const { GeminiLiveProvider, MODEL_ID: GEMINI_MODEL_ID, DEFAULT_GEMINI_LIVE_VOICE } = require('./geminiLiveProvider');
const { GrokVoiceProvider, DEFAULT_GROK_MODEL } = require('./grokVoiceProvider');
const { GEMINI_VOICES, DEFAULT_VOICE_NAME } = require('../geminiVoices');
const { GROK_VOICES, DEFAULT_GROK_VOICE_ID } = require('../grokVoices');

function normalizeProviderName(value, fallback = 'mock') {
    const provider = String(value || '').trim().toLowerCase();
    if (provider === 'xai') return 'grok';
    return ['mock', 'gemini', 'grok'].includes(provider) ? provider : fallback;
}

function createRealtimeProviderRegistry(config = {}, commonMetadata = {}, overrides = {}) {
    const defaultProvider = normalizeProviderName(config.defaultProvider || process.env.REALTIME_PROVIDER || 'mock');
    const geminiKey = config.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
    const grokKey = config.grokApiKey ?? process.env.GROK_API_KEY ?? process.env.XAI_API_KEY ?? '';
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
    };

    function publicDefinition(definition) {
        return {
            id: definition.id,
            label: definition.label,
            configured: definition.configured,
            model: definition.model,
            default_voice: definition.defaultVoice,
            voices: definition.voices,
        };
    }

    function list() {
        return ['gemini', 'grok']
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

    return {
        defaultProvider,
        list,
        resolve,
        resolveDefault,
        get: (providerId) => publicDefinition(definitions[normalizeProviderName(providerId, defaultProvider)]),
    };
}

module.exports = {
    createRealtimeProviderRegistry,
    normalizeProviderName,
};

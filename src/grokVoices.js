'use strict';

const DEFAULT_GROK_VOICE_ID = (process.env.GROK_VOICE_ID || process.env.XAI_VOICE_ID || 'rex').trim() || 'rex';
const VOICE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.GROK_VOICE_CACHE_TTL_MS || 15 * 60 * 1000));

// Stable fallback for local/offline startup. When an xAI key is configured the
// server refreshes this list from GET /v1/tts/voices and keeps the result in
// memory, so new built-in or custom voices do not require a dashboard release.
const GROK_VOICES = Object.freeze([
    { id: 'rex', name: 'Rex', characteristic: 'Confident and clear' },
    { id: 'leo', name: 'Leo', characteristic: 'Authoritative and strong' },
    { id: 'sal', name: 'Sal', characteristic: 'Smooth and balanced' },
    { id: 'atlas', name: 'Atlas', characteristic: 'Confident and commanding' },
    { id: 'rigel', name: 'Rigel', characteristic: 'Professional and calm' },
    { id: 'castor', name: 'Castor', characteristic: 'Charismatic and easygoing' },
    { id: 'naksh', name: 'Naksh', characteristic: 'Warm and thoughtful' },
    { id: 'lumen', name: 'Lumen', characteristic: 'Warm and articulate' },
    { id: 'ara', name: 'Ara', characteristic: 'Warm and friendly' },
    { id: 'eve', name: 'Eve', characteristic: 'Energetic and upbeat' },
    { id: 'celeste', name: 'Celeste', characteristic: 'Compassionate and reassuring' },
    { id: 'ursa', name: 'Ursa', characteristic: 'Friendly and steadfast' },
    { id: 'kepler', name: 'Kepler', characteristic: 'Inventive and charismatic' },
    { id: 'cosmo', name: 'Cosmo', characteristic: 'Bright and curious' },
    { id: 'sirius', name: 'Sirius', characteristic: 'Quick-witted and playful' },
]);

let cachedVoices = null;
let cachedAt = 0;

function normalizeGrokVoiceId(value, fallback = DEFAULT_GROK_VOICE_ID) {
    const voiceId = String(value || '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(voiceId) ? voiceId : fallback;
}

function mergeVoiceMetadata(voices) {
    const fallbackById = new Map(GROK_VOICES.map((voice) => [voice.id, voice]));
    return voices
        .map((voice) => {
            const id = normalizeGrokVoiceId(voice.voice_id || voice.id, '');
            if (!id) return null;
            const fallback = fallbackById.get(id);
            return {
                id,
                name: String(voice.name || fallback?.name || id),
                characteristic: String(voice.description || voice.characteristic || fallback?.characteristic || 'Multilingual'),
            };
        })
        .filter(Boolean);
}

async function listGrokVoices({ apiKey, fetchImpl = globalThis.fetch, force = false } = {}) {
    const key = apiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY || '';
    if (!key || typeof fetchImpl !== 'function') return [...GROK_VOICES];
    if (!force && cachedVoices && Date.now() - cachedAt < VOICE_CACHE_TTL_MS) return [...cachedVoices];

    try {
        const response = await fetchImpl('https://api.x.ai/v1/tts/voices', {
            headers: { authorization: `Bearer ${key}` },
        });
        if (!response.ok) throw new Error(`grok_voices_http_${response.status}`);
        const payload = await response.json();
        const voices = mergeVoiceMetadata(Array.isArray(payload?.voices) ? payload.voices : []);
        if (voices.length === 0) throw new Error('grok_voices_empty');
        cachedVoices = voices;
        cachedAt = Date.now();
        return [...cachedVoices];
    } catch {
        return cachedVoices ? [...cachedVoices] : [...GROK_VOICES];
    }
}

module.exports = {
    GROK_VOICES,
    DEFAULT_GROK_VOICE_ID,
    listGrokVoices,
    normalizeGrokVoiceId,
};

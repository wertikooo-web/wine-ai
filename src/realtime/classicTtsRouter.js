'use strict';

const DEFAULT_YANDEX_VOICE_RU = process.env.CLASSIC_YANDEX_VOICE_RU || 'alena';
const DEFAULT_YANDEX_SPEED = Number(process.env.CLASSIC_YANDEX_SPEED || 0.9);
const YANDEX_TTS_URL = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const YANDEX_SAMPLE_RATE = 16000;

function normalizeLanguage(value, text = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'ru' || raw.startsWith('ru-') || raw.includes('russian')) return 'ru';
    if (raw === 'ro' || raw.startsWith('ro-') || raw.includes('romanian')) return 'ro';
    if (raw === 'en' || raw.startsWith('en-') || raw.includes('english')) return 'en';
    if (/[а-яё]/i.test(text)) return 'ru';
    if (/[ăâîșşțţ]/i.test(text)) return 'ro';
    return 'en';
}

class ClassicTtsRouter {
    constructor(config = {}, dependencies = {}) {
        this.fetchImpl = dependencies.fetchImpl || globalThis.fetch;
        this.yandexApiKey = config.yandexApiKey || process.env.YANDEX_API_KEY || '';
        this.yandexFolderId = config.yandexFolderId || process.env.YANDEX_FOLDER_ID || '';
        this.yandexVoiceRu = config.yandexVoiceRu || DEFAULT_YANDEX_VOICE_RU;
        this.yandexSpeed = Number(config.yandexSpeed || DEFAULT_YANDEX_SPEED);
    }

    get yandexConfigured() {
        return Boolean(this.yandexApiKey && this.yandexFolderId && typeof this.fetchImpl === 'function');
    }

    chooseProvider(language, text) {
        const normalized = normalizeLanguage(language, text);
        if (normalized === 'ru' && this.yandexConfigured) return 'yandex';
        return 'gemini';
    }

    async synthesizeRussian(text, options = {}) {
        if (!this.yandexConfigured) {
            throw Object.assign(new Error('classic_yandex_tts_not_configured'), { code: 'classic_yandex_tts_not_configured' });
        }
        const body = new URLSearchParams({
            text: String(text || ''),
            voice: options.voice || this.yandexVoiceRu,
            speed: String(options.speed || this.yandexSpeed),
            format: 'lpcm',
            sampleRateHertz: String(YANDEX_SAMPLE_RATE),
            folderId: this.yandexFolderId,
        });
        const response = await this.fetchImpl(YANDEX_TTS_URL, {
            method: 'POST',
            headers: {
                Authorization: `Api-Key ${this.yandexApiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            signal: options.signal,
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw Object.assign(new Error(`classic_yandex_tts_failed:${response.status}`), {
                code: 'classic_yandex_tts_failed',
                status: response.status,
                detail: detail.slice(0, 300),
            });
        }
        return {
            provider: 'yandex',
            language: 'ru',
            sampleRate: YANDEX_SAMPLE_RATE,
            pcm: Buffer.from(await response.arrayBuffer()),
        };
    }
}

module.exports = {
    ClassicTtsRouter,
    normalizeLanguage,
    DEFAULT_YANDEX_VOICE_RU,
    YANDEX_SAMPLE_RATE,
};

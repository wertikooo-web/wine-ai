'use strict';

const DEFAULT_STT_PROVIDER = String(process.env.CLASSIC_STT_PROVIDER || 'whisper').trim().toLowerCase();
const DEFAULT_WHISPER_MODEL = process.env.CLASSIC_STT_MODEL || 'whisper-1';
const DEFAULT_DEEPGRAM_MODEL = process.env.CLASSIC_DEEPGRAM_MODEL || 'nova-3';
const DEFAULT_LANGUAGE = process.env.DEFAULT_STT_LANGUAGE || process.env.STT_LANGUAGE || 'auto';
const MIN_PCM_BYTES = Number(process.env.CLASSIC_MIN_STT_PCM_BYTES || 6000);
const SAMPLE_RATE = 16000;

const WINE_WHISPER_PROMPT = process.env.CLASSIC_WHISPER_PROMPT || [
    'Разговор с цифровым сомелье WINE AI.',
    'Вина и винодельни Молдовы, сорта винограда, гастрономические сочетания.',
    'Fetească Neagră, Fetească Albă, Fetească Regală, Rară Neagră, Viorica,',
    'Codru, Ștefan Vodă, Valul lui Traian, Divin, Cricova, Mileștii Mici, Purcari.'
].join(' ');

function pcm16ToWav(pcm, sampleRate = SAMPLE_RATE) {
    const payload = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    const wav = Buffer.allocUnsafe(44 + payload.length);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36 + payload.length, 4);
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(payload.length, 40);
    payload.copy(wav, 44);
    return wav;
}

function normalizeLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'auto') return null;
    if (raw === 'ru' || raw.startsWith('ru-') || raw.includes('russian')) return 'ru';
    if (raw === 'ro' || raw.startsWith('ro-') || raw.includes('romanian')) return 'ro';
    if (raw === 'en' || raw.startsWith('en-') || raw.includes('english')) return 'en';
    return null;
}

function normalizeDetectedLanguage(value) {
    const iso = normalizeLanguage(value);
    if (iso === 'ru') return 'ru-RU';
    if (iso === 'ro') return 'ro-RO';
    if (iso === 'en') return 'en-US';
    return null;
}

function normalizeText(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function createAbortController(parentSignal) {
    const controller = new AbortController();
    if (parentSignal?.aborted || parentSignal?.cancelled) {
        controller.abort(parentSignal.reason || 'cancelled');
    }
    return controller;
}

function createWhisperAdapter(config = {}, dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || '';
    const model = config.sttModel || DEFAULT_WHISPER_MODEL;

    return {
        id: 'whisper',
        model,
        configured: Boolean(apiKey),
        async transcribe(pcm, options = {}) {
            if (!apiKey) throw Object.assign(new Error('classic_whisper_api_key_missing'), { code: 'classic_stt_api_key_missing' });
            if (typeof fetchImpl !== 'function') throw new Error('classic_fetch_unavailable');
            if (!pcm?.length || pcm.length < MIN_PCM_BYTES) {
                return { text: '', language: null, skipped: 'too_short' };
            }

            const wav = pcm16ToWav(pcm);
            const form = new FormData();
            form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
            form.append('model', model);
            form.append('response_format', 'verbose_json');
            form.append('temperature', '0.1');
            form.append('prompt', WINE_WHISPER_PROMPT);
            const language = normalizeLanguage(options.language || DEFAULT_LANGUAGE);
            if (language) form.append('language', language);

            const controller = createAbortController(options.signal);
            options.onController?.(controller);
            const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw Object.assign(new Error(`classic_whisper_failed:${response.status}`), {
                    code: 'classic_stt_failed', status: response.status, detail: detail.slice(0, 300),
                });
            }
            const payload = await response.json();
            return {
                text: normalizeText(payload?.text),
                language: normalizeDetectedLanguage(payload?.language) || normalizeDetectedLanguage(language),
                provider: 'whisper',
                model,
            };
        },
    };
}

function createDeepgramAdapter(config = {}, dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
    const apiKey = config.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '';
    const model = config.deepgramModel || DEFAULT_DEEPGRAM_MODEL;

    return {
        id: 'deepgram',
        model,
        configured: Boolean(apiKey),
        async transcribe(pcm, options = {}) {
            if (!apiKey) throw Object.assign(new Error('classic_deepgram_api_key_missing'), { code: 'classic_stt_api_key_missing' });
            if (!pcm?.length || pcm.length < MIN_PCM_BYTES) {
                return { text: '', language: null, skipped: 'too_short' };
            }
            const query = new URLSearchParams({
                model, detect_language: 'true', smart_format: 'true', numerals: 'true',
                encoding: 'linear16', sample_rate: String(SAMPLE_RATE), channels: '1',
            });
            const controller = createAbortController(options.signal);
            options.onController?.(controller);
            const response = await fetchImpl(`https://api.deepgram.com/v1/listen?${query}`, {
                method: 'POST',
                headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/raw' },
                body: pcm,
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw Object.assign(new Error(`classic_deepgram_failed:${response.status}`), {
                    code: 'classic_stt_failed', status: response.status, detail: detail.slice(0, 300),
                });
            }
            const payload = await response.json();
            const channel = payload?.results?.channels?.[0];
            return {
                text: normalizeText(channel?.alternatives?.[0]?.transcript),
                language: normalizeDetectedLanguage(channel?.detected_language || payload?.metadata?.detected_language),
                provider: 'deepgram',
                model,
            };
        },
    };
}

function createClassicSttAdapter(config = {}, dependencies = {}) {
    const requested = String(config.sttProvider || DEFAULT_STT_PROVIDER).trim().toLowerCase();
    if (requested === 'deepgram') return createDeepgramAdapter(config, dependencies);
    return createWhisperAdapter(config, dependencies);
}

module.exports = {
    DEFAULT_STT_PROVIDER,
    DEFAULT_WHISPER_MODEL,
    DEFAULT_DEEPGRAM_MODEL,
    MIN_PCM_BYTES,
    SAMPLE_RATE,
    WINE_WHISPER_PROMPT,
    pcm16ToWav,
    normalizeLanguage,
    normalizeDetectedLanguage,
    createWhisperAdapter,
    createDeepgramAdapter,
    createClassicSttAdapter,
};

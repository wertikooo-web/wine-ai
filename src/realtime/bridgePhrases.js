'use strict';

// "Bridge" phrases: when a tool call (knowledge search) keeps the assistant
// silent for longer than BRIDGE_DELAY_MS (default 1000), the server sends
// the client a short pre-rendered phrase ("Минуточку, сейчас посмотрю.") in
// the persona's own voice. The
// client plays it on a separate audio node; when the real answer arrives the
// phrase is said to the end and the answer queued after it. It is cut only
// when the user speaks or the conversation stops.
//
// Deliberately outside the model and outside the turn lifecycle: the model
// never produces or hears these phrases, and no generation/turn state is
// read or changed -- a bridge is a pure side effect with its own timer. Off
// unless BRIDGE_PHRASES_ENABLED=true (kill switch without a deploy).

// Short full sentences, no trailing ellipsis: Gemini TTS returned no audio
// for "Секунду…" / "O clipă…" (production, voice Leda). Gender-neutral.
// The persona forbids the MODEL from promising a lookup; a bridge only
// plays while a tool call is actually running, so here it is true.
const PHRASES = Object.freeze({
    ru: ['Минуточку, сейчас посмотрю.', 'Хороший вопрос, сейчас проверю.', 'Так, дайте уточню.'],
    ro: ['O clipă, verific imediat.', 'Bună întrebare, vă spun imediat.', 'Un moment, să verific.'],
    en: ['One moment, let me check.', 'Good question, let me check.', 'Let me look that up.'],
});

function bridgeConfig(env = process.env) {
    return {
        enabled: String(env.BRIDGE_PHRASES_ENABLED || '').trim().toLowerCase() === 'true',
        delayMs: Math.max(0, Number(env.BRIDGE_DELAY_MS || 1000)),
        // A bridge is allowed at most once per this many turns, so it does
        // not become a verbal tic on every question.
        minTurnGap: Math.max(1, Number(env.BRIDGE_MIN_TURN_GAP || 2)),
    };
}

function normalizeLanguage(value) {
    const lang = String(value || '').slice(0, 2).toLowerCase();
    return PHRASES[lang] ? lang : 'ru';
}

const TOTAL_PHRASES = Object.values(PHRASES).reduce((n, list) => n + list.length, 0);

// Process-wide cache of rendered phrases: key voice|lang|index.
//
// Gemini TTS sometimes returns no audio for a phrase (production: "Секунду…"
// with voice Leda, every time) or fails under a burst of calls. A render is
// retried once; phrases still missing are re-rendered by a later warm() for
// that voice, at most once per retryCooldownMs. (Before: one warm job per
// voice for the life of the process, so a failed render never came back.)
function createBridgeAudioCache({ synthesize, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 1500, renderGapMs = 250, retryCooldownMs = 60000 } = {}) {
    const audio = new Map();
    const inFlight = new Map(); // voice -> job
    const lastAttemptAt = new Map(); // voice -> ms

    function key(voice, lang, index) { return `${voice}|${lang}|${index}`; }

    function renderedCount(voice) {
        return [...audio.keys()].filter((k) => k.startsWith(`${voice}|`)).length;
    }

    async function renderOne(voice, lang, index) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const rendered = await synthesize({ voiceName: voice, text: PHRASES[lang][index] });
                if (rendered && rendered.audioBase64) {
                    audio.set(key(voice, lang, index), { audioBase64: rendered.audioBase64, sampleRate: rendered.sampleRate || 24000 });
                    return true;
                }
                log('bridge_phrase_render_failed', { voice, lang, index, attempt, message: 'empty_audio' });
            } catch (error) {
                log('bridge_phrase_render_failed', { voice, lang, index, attempt, message: String(error && error.message || error).slice(0, 120) });
            }
            if (attempt === 1) await sleep(retryDelayMs);
        }
        return false;
    }

    function warm(voice) {
        if (!voice || typeof synthesize !== 'function') return Promise.resolve();
        if (inFlight.has(voice)) return inFlight.get(voice);
        if (renderedCount(voice) >= TOTAL_PHRASES) return Promise.resolve();
        const last = lastAttemptAt.get(voice);
        if (last !== undefined && now() - last < retryCooldownMs) return Promise.resolve();
        lastAttemptAt.set(voice, now());
        const job = (async () => {
            let first = true;
            for (const lang of Object.keys(PHRASES)) {
                for (let index = 0; index < PHRASES[lang].length; index += 1) {
                    if (audio.has(key(voice, lang, index))) continue;
                    if (!first && renderGapMs > 0) await sleep(renderGapMs);
                    first = false;
                    await renderOne(voice, lang, index);
                }
            }
            const missing = [];
            for (const lang of Object.keys(PHRASES)) {
                for (let index = 0; index < PHRASES[lang].length; index += 1) if (!audio.has(key(voice, lang, index))) missing.push(`${lang}${index}`);
            }
            log('bridge_phrases_ready', { voice, count: renderedCount(voice), total: TOTAL_PHRASES, missing: missing.join(',') || 'none' });
        })().finally(() => inFlight.delete(voice));
        inFlight.set(voice, job);
        return job;
    }

    function get(voice, lang, index) {
        return audio.get(key(voice, lang, index)) || null;
    }

    // Read-only status for /health: rendered phrase count per voice.
    function status() {
        const voices = {};
        for (const k of audio.keys()) {
            const voice = k.split('|')[0];
            voices[voice] = (voices[voice] || 0) + 1;
        }
        return { total_per_voice: TOTAL_PHRASES, rendered: voices };
    }

    const cache = { warm, get, status, size: () => audio.size };
    lastCache = cache;
    return cache;
}

// Operator status (/health): config plus what the process-wide cache has
// rendered. No audio, no text, no keys.
let lastCache = null;
function bridgeStatus(env = process.env) {
    const config = bridgeConfig(env);
    return { enabled: config.enabled, delay_ms: config.delayMs, min_turn_gap: config.minTurnGap, ...(lastCache ? lastCache.status() : { total_per_voice: TOTAL_PHRASES, rendered: {} }) };
}

// Per-connection scheduler. `emit` sends to this client only.
function createBridgeScheduler({ config = bridgeConfig(), cache, emit, log = () => {}, getVoice, getLanguage, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const timers = new Map(); // generationId -> timer
    let lastBridgeTurn = -Infinity;
    let rotation = 0;
    let disposed = false;

    function cancel(generationId) {
        const timer = timers.get(generationId);
        if (timer) {
            clearTimer(timer);
            timers.delete(generationId);
            // The answer (or another provider event) arrived before the delay.
            log('bridge_cancelled', { generationId });
        }
    }

    function cancelAll() {
        for (const timer of timers.values()) clearTimer(timer);
        timers.clear();
    }

    function onToolCall({ generationId, turnId, turnNumber }) {
        if (!config.enabled || disposed || !generationId || !cache) return false;
        if (timers.has(generationId)) return false;
        if (turnNumber - lastBridgeTurn < config.minTurnGap) return false;
        const voice = typeof getVoice === 'function' ? getVoice() : null;
        if (!voice) return false;
        cache.warm(voice);
        const timer = setTimer(() => {
            timers.delete(generationId);
            if (disposed) return;
            const lang = normalizeLanguage(typeof getLanguage === 'function' ? getLanguage() : null);
            const phrases = PHRASES[lang];
            // First rendered phrase from the rotation point. Before, a single
            // phrase without audio at the rotation point blocked every bridge
            // for the rest of the process (rotation only advanced on success).
            let index = -1;
            let rendered = null;
            for (let step = 0; step < phrases.length; step += 1) {
                const candidate = (rotation + step) % phrases.length;
                rendered = cache.get(voice, lang, candidate);
                if (rendered) { index = candidate; break; }
            }
            if (!rendered) {
                log('bridge_skipped', { generationId, reason: 'no_rendered_phrase', voice, lang, phrases: phrases.length });
                cache.warm(voice); // re-render what is missing (rate-limited)
                return;
            }
            rotation = index + 1;
            lastBridgeTurn = turnNumber;
            emit({
                type: 'assistant.bridge',
                generation_id: generationId,
                turn_id: turnId,
                language: lang,
                text: phrases[index],
                sample_rate: rendered.sampleRate,
                audio_base64: rendered.audioBase64,
            });
            log('bridge_sent', { generationId, turnId, lang, index, delayMs: config.delayMs });
        }, config.delayMs);
        timers.set(generationId, timer);
        return true;
    }

    function dispose() {
        disposed = true;
        cancelAll();
    }

    // Render this session's voice ahead of the first tool call.
    function prewarm() {
        if (!config.enabled || disposed || !cache) return;
        const voice = typeof getVoice === 'function' ? getVoice() : null;
        if (voice) cache.warm(voice);
    }

    return { onToolCall, cancel, cancelAll, dispose, prewarm, pending: () => timers.size };
}

module.exports = { PHRASES, TOTAL_PHRASES, bridgeConfig, bridgeStatus, normalizeLanguage, createBridgeAudioCache, createBridgeScheduler };

'use strict';

// "Bridge" phrases: when a tool call (knowledge search) keeps the assistant
// silent for longer than BRIDGE_DELAY_MS (default 2000), the server sends
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
        // Voice bench on prod: local search answers in ~1 s, web lookups take
        // 5-6 s. With 1000 ms / every 2nd turn the filler covered fast
        // searches and skipped slow ones (6-8 s of silence). 2000 ms lets
        // fast searches answer without a filler, and a filler may now play
        // on every slow turn: being slow, not the turn count, decides.
        delayMs: Math.max(0, Number(env.BRIDGE_DELAY_MS || 2000)),
        // A bridge is allowed at most once per this many turns.
        minTurnGap: Math.max(1, Number(env.BRIDGE_MIN_TURN_GAP || 1)),
    };
}

function normalizeLanguage(value) {
    const lang = String(value || '').slice(0, 2).toLowerCase();
    return PHRASES[lang] ? lang : 'ru';
}

const TOTAL_PHRASES = Object.values(PHRASES).reduce((n, list) => n + list.length, 0);

const { phraseKey } = require('./bridgePhraseStore');

// Process-wide cache of rendered phrases: key voice|lang|index.
//
// Gemini TTS sometimes returns no audio for a phrase (production: "Секунду…"
// with voice Leda, every time) or fails under a burst of calls. A render is
// retried once; phrases still missing are re-rendered by a later warm() for
// that voice, at most once per retryCooldownMs. (Before: one warm job per
// voice for the life of the process, so a failed render never came back.)
//
// Optional `store` (bridgePhraseStore.js): audio rendered by any earlier
// process is loaded from it first, and every new render is saved to it, so
// a deploy does not have to call TTS again.
// `phrases` (default: the bridge PHRASES) lets the same cache render other
// fixed lines, e.g. the service lines in scriptedLines.js.
function createBridgeAudioCache({ synthesize, store = null, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryDelayMs = 1500, renderGapMs = 250, retryCooldownMs = 60000, phrases = PHRASES, label = 'bridge' } = {}) {
    const PHRASES = phrases; // shadows the module set for this cache
    const TOTAL_PHRASES = Object.values(PHRASES).reduce((n, list) => n + list.length, 0);
    const audio = new Map();
    const inFlight = new Map(); // voice -> job
    const lastAttemptAt = new Map(); // voice -> ms
    const loadedFromStore = new Set(); // voices whose stored audio was read
    let storedCount = 0;

    async function loadStored(voice) {
        if (!store || loadedFromStore.has(voice)) return;
        try {
            const entries = await store.load(voice);
            let loaded = 0;
            for (const lang of Object.keys(PHRASES)) {
                for (let index = 0; index < PHRASES[lang].length; index += 1) {
                    const entry = entries.get(phraseKey(voice, lang, index, PHRASES[lang][index]));
                    if (entry && !audio.has(key(voice, lang, index))) {
                        audio.set(key(voice, lang, index), entry);
                        loaded += 1;
                    }
                }
            }
            loadedFromStore.add(voice);
            storedCount += loaded;
            log(`${label}_phrases_loaded`, { voice, loaded });
        } catch (error) {
            log('bridge_phrase_store_failed', { voice, op: 'load', message: String(error && error.message || error).slice(0, 120) });
        }
    }

    async function saveStored(voice, lang, index, entry) {
        if (!store) return;
        try {
            await store.save(phraseKey(voice, lang, index, PHRASES[lang][index]), entry);
        } catch (error) {
            log('bridge_phrase_store_failed', { voice, op: 'save', message: String(error && error.message || error).slice(0, 120) });
        }
    }

    function key(voice, lang, index) { return `${voice}|${lang}|${index}`; }

    function renderedCount(voice) {
        return [...audio.keys()].filter((k) => k.startsWith(`${voice}|`)).length;
    }

    async function renderOne(voice, lang, index) {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const rendered = await synthesize({ voiceName: voice, text: PHRASES[lang][index] });
                if (rendered && rendered.audioBase64) {
                    const entry = { audioBase64: rendered.audioBase64, sampleRate: rendered.sampleRate || 24000 };
                    audio.set(key(voice, lang, index), entry);
                    await saveStored(voice, lang, index, entry);
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
            await loadStored(voice);
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
            log(`${label}_phrases_ready`, { voice, count: renderedCount(voice), total: TOTAL_PHRASES, missing: missing.join(',') || 'none' });
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
        return { total_per_voice: TOTAL_PHRASES, rendered: voices, persistent: Boolean(store), loaded_from_store: storedCount };
    }

    const cache = { warm, get, status, size: () => audio.size };
    if (label === 'bridge') lastCache = cache;
    return cache;
}

// Render (or load from the store) the phrases of several voices one voice
// after another, so a new persona voice has its phrases before its first
// question, without a burst of parallel TTS calls. Never throws.
async function prewarmVoices(cache, voices = []) {
    if (!cache) return;
    for (const voice of [...new Set(voices.filter(Boolean))]) {
        try { await cache.warm(voice); } catch { /* warm logs its own failures */ }
    }
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
            const lang = normalizeLanguage(typeof getLanguage === 'function' ? getLanguage(generationId) : null);
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

module.exports = { PHRASES, TOTAL_PHRASES, bridgeConfig, bridgeStatus, normalizeLanguage, createBridgeAudioCache, createBridgeScheduler, prewarmVoices };

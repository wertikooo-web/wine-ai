'use strict';

// "Bridge" phrases: when a tool call (knowledge search) keeps the assistant
// silent for longer than BRIDGE_DELAY_MS, the server sends the client a
// short pre-rendered phrase ("Секунду…") in the persona's own voice. The
// client plays it on a separate audio node and cuts it the moment the real
// answer starts, the user speaks, or the conversation stops.
//
// Deliberately outside the model and outside the turn lifecycle: the model
// never produces or hears these phrases, and no generation/turn state is
// read or changed -- a bridge is a pure side effect with its own timer. Off
// unless BRIDGE_PHRASES_ENABLED=true (kill switch without a deploy).

const PHRASES = Object.freeze({
    ru: ['Секунду…', 'Хороший вопрос, сейчас подскажу.', 'Так, дайте вспомнить…', 'Интересно… минутку.'],
    ro: ['O clipă…', 'Bună întrebare, vă spun imediat.', 'Stați să-mi amintesc…'],
    en: ['One moment…', 'Good question, let me think.', 'Let me see…'],
});

function bridgeConfig(env = process.env) {
    return {
        enabled: String(env.BRIDGE_PHRASES_ENABLED || '').trim().toLowerCase() === 'true',
        delayMs: Math.max(0, Number(env.BRIDGE_DELAY_MS || 1200)),
        // A bridge is allowed at most once per this many turns, so it does
        // not become a verbal tic on every question.
        minTurnGap: Math.max(1, Number(env.BRIDGE_MIN_TURN_GAP || 2)),
    };
}

function normalizeLanguage(value) {
    const lang = String(value || '').slice(0, 2).toLowerCase();
    return PHRASES[lang] ? lang : 'ru';
}

// Process-wide cache of rendered phrases: key voice|lang|index.
function createBridgeAudioCache({ synthesize, log = () => {} } = {}) {
    const audio = new Map();
    const warming = new Map();

    function key(voice, lang, index) { return `${voice}|${lang}|${index}`; }

    function warm(voice) {
        if (!voice || typeof synthesize !== 'function') return Promise.resolve();
        if (warming.has(voice)) return warming.get(voice);
        const job = (async () => {
            for (const lang of Object.keys(PHRASES)) {
                for (let index = 0; index < PHRASES[lang].length; index += 1) {
                    const k = key(voice, lang, index);
                    if (audio.has(k)) continue;
                    try {
                        const rendered = await synthesize({ voiceName: voice, text: PHRASES[lang][index] });
                        if (rendered && rendered.audioBase64) {
                            audio.set(k, { audioBase64: rendered.audioBase64, sampleRate: rendered.sampleRate || 24000 });
                        }
                    } catch (error) {
                        log('bridge_phrase_render_failed', { voice, lang, index, message: String(error && error.message || error).slice(0, 120) });
                    }
                }
            }
            log('bridge_phrases_ready', { voice, count: [...audio.keys()].filter((k) => k.startsWith(`${voice}|`)).length });
        })();
        warming.set(voice, job);
        return job;
    }

    function get(voice, lang, index) {
        return audio.get(key(voice, lang, index)) || null;
    }

    return { warm, get, size: () => audio.size };
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
            const index = rotation % phrases.length;
            const rendered = cache.get(voice, lang, index);
            if (!rendered) {
                log('bridge_skipped', { generationId, reason: 'not_rendered_yet', voice, lang });
                return;
            }
            rotation += 1;
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

module.exports = { PHRASES, bridgeConfig, normalizeLanguage, createBridgeAudioCache, createBridgeScheduler };

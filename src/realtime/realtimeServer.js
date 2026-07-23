'use strict';

// NOTE ON MICROPHONE AUDIO SAMPLE RATE: a client may send microphone audio
// at 16000Hz or 24000Hz PCM16LE mono binary WS frames, declared via
// `sampleRate`/`sample_rate` in session.start. This
// file resamples 24000Hz input down to Gemini's required 16000Hz input
// explicitly, in-line, right where audio frames are received (see the
// `onBinary` handler below and `startInput`/`endInput`/session.interrupt
// for where the resampler's per-turn state is reset/flushed) — using
// resolveInputSampleRate()/createInputResampler() from
// ./inputAudioResampling.js. There is no preload/monkey-patch layer; the
// conversion point is visible from this file.
const crypto = require('crypto');
const {
    acceptWebSocket,
    createFrameParser,
    sendJson,
    sendPong,
    sendClose,
} = require('./wsProtocol');
const {
    resolveInputSampleRate,
    createInputResampler,
    GEMINI_INPUT_SAMPLE_RATE,
} = require('./inputAudioResampling');
const { MockRealtimeProvider, DEFAULT_CONFIG } = require('./mockRealtimeProvider');
const { createVisualOrchestrator } = require('../visual/visualOrchestrator');
const {
    DASHBOARD_ALLOW_CUSTOM_PROMPT,
    PROMPT_MAX_CHARS,
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
    sanitizePromptConfig,
} = require('./realtimePrompt');

function id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const VALID_ROTATION_MODES = new Set(['per_turn', 'errors_only']);
const DEFAULT_ROTATION_MODE = 'per_turn';
const configuredTurnReplayBytes = Number(process.env.REALTIME_TURN_REPLAY_MAX_BYTES);
const MAX_TURN_REPLAY_BYTES = Number.isFinite(configuredTurnReplayBytes)
    ? Math.max(0, configuredTurnReplayBytes)
    : 512 * 1024;
let warnedInvalidRotationMode = false;

function areContentToolsEnabled(value = process.env.REALTIME_CONTENT_TOOLS) {
    return /^(1|true|yes|on|enabled)$/i.test(String(value || ''));
}

function normalizeProviderVoiceName(voiceName) {
    return String(voiceName || '').trim();
}

function normalizeRotationMode(value) {
    const mode = String(value || process.env.GEMINI_ROTATION_MODE || DEFAULT_ROTATION_MODE).trim().toLowerCase();
    if (VALID_ROTATION_MODES.has(mode)) return mode;
    if (!warnedInvalidRotationMode) {
        warnedInvalidRotationMode = true;
        console.warn('[Realtime] Unknown GEMINI_ROTATION_MODE=' + JSON.stringify(mode) + '. Falling back to ' + DEFAULT_ROTATION_MODE + '.');
    }
    return DEFAULT_ROTATION_MODE;
}

// Language set matches persona's supported languages (see
// src/persona/wineExpertPersona.js's SUPPORTED_LANGUAGES). Japanese
// (hiragana/katakana) is checked before Chinese and given a higher weight
// since kana is unambiguous \u2014 a kanji-only sample without kana correctly
// falls through to 'zh', but any kana present pins it to 'ja' even though
// the CJK ideograph pattern also matches the same text.
const LANGUAGE_PATTERNS = [
    { language: 'ru', pattern: /[\u0400-\u04FF]/u, weight: 3 },
    { language: 'ro', pattern: /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/u, weight: 4 },
    { language: 'en', pattern: /\b(the|and|you|hello|please|wine|grape|winery|recommend|what|why|how)\b/i, weight: 2 },
    { language: 'ro', pattern: /\b(spune|vreau|buna|salut|struguri|crama|romana|vorbeste)\b/i, weight: 3 },
    { language: 'fr', pattern: /[\u00E9\u00E8\u00EA\u00E0\u00E7\u00F4\u00FB\u00F9]/iu, weight: 4 },
    // "vin"/"vino" are wine-domain cognates shared across fr/ro/it/es \u2014
    // matching on them made every other Romance language ambiguous with
    // whichever one still listed it (found via LANG_DEBUG: an Italian
    // sentence scored a tie between 'it' and 'es', both via "vino").
    // Distinguishing words below are deliberately non-wine vocabulary.
    { language: 'fr', pattern: /\b(le|la|les|c\u00E9page|bonjour|merci|vigne|pourquoi|comment)\b/i, weight: 4 },
    { language: 'it', pattern: /\b(ciao|grazie|vitigno|buongiorno|perch\u00E9|come|quale)\b/i, weight: 4 },
    { language: 'es', pattern: /[\u00BF\u00A1\u00F1]/u, weight: 4 },
    { language: 'es', pattern: /\b(hola|gracias|uva|qu\u00E9|c\u00F3mo)\b/i, weight: 4 },
    { language: 'de', pattern: /[\u00E4\u00F6\u00FC\u00DF\u00C4\u00D6\u00DC]/u, weight: 4 },
    { language: 'de', pattern: /\b(und|ich|nicht|wein|traube|danke|warum|wie)\b/i, weight: 4 },
    // Weight 7 so Japanese wins even when the same sentence also matches
    // the CJK ideograph pattern below (kana + kanji mixed is normal
    // Japanese text) \u2014 margin needs to stay >= 2 over zh's weight 4.
    { language: 'ja', pattern: /[\u3040-\u30FF]/u, weight: 7 },
    { language: 'zh', pattern: /[\u4E00-\u9FFF]/u, weight: 4 },
];
const MIN_LANGUAGE_SWITCH_SIGNIFICANT_WORDS = Number(process.env.LANGUAGE_SWITCH_MIN_WORDS || 3);
const LANGUAGE_SWITCH_CONFIRMATIONS = Number(process.env.LANGUAGE_SWITCH_CONFIRMATIONS || 2);
// Words that must never count as a language-switch signal on their own \u2014
// generic filler plus proper nouns from the wine domain that a speaker may
// use mid-sentence regardless of which language they are speaking.
const LANGUAGE_NOISE_WORDS = new Set([
    'ok', 'okay', 'yes', 'yeah', 'no', 'not', 'the', 'and', 'you', 'please',
    '\u0434\u0430', '\u043d\u0435\u0442', '\u0430\u0433\u0430', '\u0443\u0433\u0443', '\u043d\u0443', '\u043e\u0439', '\u044d\u0439', '\u0430\u043b\u043b\u043e',
    'wine', 'ai', 'gemini', 'crama', 'chateau', 'sommelier',
    'feteasca', 'purcari', 'cricova', 'milestii',
]);

function languageSignificantWords(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}]+/gu) || [])
        .filter((word) => word.length >= 3 && !LANGUAGE_NOISE_WORDS.has(word));
}

function detectLikelyLanguage(text) {
    const sample = String(text || '').trim();
    if (sample.length < 4) return null;
    const scores = new Map();
    for (const { language, pattern, weight } of LANGUAGE_PATTERNS) {
        if (pattern.test(sample)) {
            scores.set(language, (scores.get(language) || 0) + weight);
        }
    }
    const asciiLetters = sample.match(/[a-z]/gi)?.length || 0;
    const cyrillicLetters = sample.match(/[\u0400-\u04FF]/gu)?.length || 0;
    if (asciiLetters >= 8 && asciiLetters > cyrillicLetters * 2) {
        scores.set('en', (scores.get('en') || 0) + 2);
    }
    const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0 || ranked[0][1] < 3) return null;
    if (ranked[1] && ranked[0][1] - ranked[1][1] < 2) return null;
    return ranked[0][0];
}

function detectLanguageSignal(text) {
    const language = detectLikelyLanguage(text);
    if (!language) return null;
    const significantWordCount = languageSignificantWords(text).length;
    return {
        language,
        significantWordCount,
        confident: significantWordCount >= MIN_LANGUAGE_SWITCH_SIGNIFICANT_WORDS,
    };
}

// Default timezone for the [CURRENT CONTEXT] prompt block's local date/time
// line (no per-user timezone setting in v1 — see docs/ARCHITECTURE.md).
const DEFAULT_TIMEZONE = 'Europe/Chisinau';

// Formats `now` as a friendly "YYYY-MM-DD, HH:MM (Weekday), TIMEZONE" string
// for the [CURRENT CONTEXT] prompt block.
function formatLocalDateTime(timezone, now = new Date()) {
    const tz = timezone || DEFAULT_TIMEZONE;
    try {
        const formatted = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
            weekday: 'long',
        }).format(now);
        return `${formatted} (${tz})`;
    } catch {
        return `${now.toISOString()} (UTC)`;
    }
}

function createCancellation() {
    return {
        cancelled: false,
        reason: null,
        cancelledAt: 0,
        cancel(reason) {
            this.cancelled = true;
            this.reason = reason;
            this.cancelledAt = Date.now();
        },
    };
}

function createGeneration({ turnId }) {
    return {
        turnId,
        generationId: id('generation'),
        responseId: null,
        status: 'pending',
        responseCreatedSent: false,
        cancel: createCancellation(),
        timeoutTimer: null,
        timeoutLogged: false,
        providerRetryAttempted: false,
        inputEndedAt: 0,
        firstInputTranscriptionAt: 0,
        firstModelEventAt: 0,
        firstValidAudioAt: 0,
        userTranscriptBuffer: '',
        memoryExtractionStarted: false,
        safetyCheckStarted: false,
    };
}

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || ((sessionOptions = {}) => defaultProvider.createSession(sessionOptions));
    const providerMetadata = options.providerMetadata || { provider: 'mock', model: 'mock' };
    const resolveProvider = typeof options.resolveProvider === 'function' ? options.resolveProvider : null;

    server.on('upgrade', (req, socket) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/realtime') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        let connectionProviderFactory = providerFactory;
        let connectionProviderMetadata = providerMetadata;
        if (resolveProvider) {
            try {
                const resolved = resolveProvider(url.searchParams.get('provider'));
                connectionProviderFactory = resolved.createSession;
                connectionProviderMetadata = resolved.metadata;
            } catch (error) {
                socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRealtime provider is not configured.');
                socket.destroy();
                return;
            }
        }

        if (!acceptWebSocket(req, socket)) return;
        createRealtimeSession(socket, connectionProviderFactory, connectionProviderMetadata);
    });
}

function createRealtimeSession(socket, providerFactory, providerMetadata = {}) {
    const sessionId = id('session');
    const connectedAt = Date.now();
    let sessionVoiceName = normalizeProviderVoiceName(providerMetadata.defaultVoiceName || providerMetadata.voiceName);
    let sessionVoiceConfigSource = sessionVoiceName
        ? (providerMetadata.defaultVoiceConfigSource || (providerMetadata.defaultVoiceName ? 'default' : 'metadata'))
        : 'provider_default';
    let promptBlocks = defaultPromptBlocks();
    let promptSource = 'default';
    const recentTurns = [];
    let assistantTranscriptBuffer = '';
    let currentTurnId = null;
    let currentGeneration = null;
    let inputStartedAt = 0;
    let inputEndedAt = 0;
    let inputBytes = 0;
    let currentInputChunks = [];
    let currentInputBufferedBytes = 0;
    let sessionInputBytes = 0;
    let currentMode = 'push_to_talk';
    let turnCounter = 0;
    let socketClosed = false;
    let providerClosed = false;
    let readySent = false;
    const rotationMode = normalizeRotationMode(providerMetadata.rotationMode);
    let providerSessionReuseCount = 0;
    let providerRotationCount = 0;
    let promptApplyCount = 0;
    let lateProviderEventsDropped = 0;
    let sessionLanguage = null;
    let pendingLanguageSwitch = null;
    let pendingLanguageCandidate = null;
    const contentToolsEnabled = areContentToolsEnabled(providerMetadata.contentToolsEnabled);
    // Wine tool declarations/handlers are domain content, not transport code
    // — supplied by src/tools/index.js via providerMetadata, the same
    // injection point the transport core exposed for its original (now
    // removed) local tools. See docs/ARCHITECTURE.md's "Tools" section.
    const toolDeclarations = Array.isArray(providerMetadata.toolDeclarations) ? providerMetadata.toolDeclarations : [];
    // Per-session memory (src/memory/sessionMemory.js) — created once per
    // WebSocket connection, never shared across sessions/users. Optional:
    // absent when providerMetadata doesn't supply a factory (e.g. minimal
    // test harnesses).
    const sessionMemory = typeof providerMetadata.createSessionMemory === 'function'
        ? providerMetadata.createSessionMemory()
        : null;
    // Tool handlers may need the session's own memory (e.g. a tool that
    // records a discussed wine/preference) — so, like the turn/generation
    // state they already close over, they are built once per session via
    // an optional factory rather than shared as one static object.
    const toolHandlers = typeof providerMetadata.createToolHandlers === 'function'
        ? providerMetadata.createToolHandlers({ sessionMemory, log: (stage, extra) => log(stage, extra) })
        : (providerMetadata.toolHandlers && typeof providerMetadata.toolHandlers === 'object' ? providerMetadata.toolHandlers : {});
    // Full prompt text (persona/knowledge_context, tens of KB combined — up
    // to PROMPT_MAX_CHARS per block) is only useful for the dashboard's
    // debug view. Defaults to false; the dashboard client opts in by
    // sending include_prompt_debug: true on session.start (see
    // safePromptPayload()/emitPromptApplied() below).
    let promptDebugRequested = false;
    // Live date/time for the [CURRENT CONTEXT] prompt block, refreshed on
    // every session.start.
    let cachedLocalDateTime = null;
    // ---- Microphone input resampling state ----
    // Configured explicitly on every session.start from
    // resolveInputSampleRate() (sampleRate/sample_rate in the payload).
    // inputResampler is a fresh Pcm16MonoResampler for the currently
    // declared inputSampleRate; at 16000 it's a byte-identical pass-through,
    // at 24000 it actually resamples down to GEMINI_INPUT_SAMPLE_RATE.
    // Reset points: startInput() (new turn), endInput() (flush the tail
    // before providerSession.endInput()), session.interrupt, and on a
    // decode error (see onBinary below) — see requirements in
    // inputAudioResampling.js/pcm16Resampler.js.
    let inputSampleRate = GEMINI_INPUT_SAMPLE_RATE;
    let inputSampleRateSource = 'assumed_default_no_sample_rate';
    let inputResampler = createInputResampler(inputSampleRate);
    let providerSession = providerFactory(buildProviderSessionOptions('initial'));

    function log(stage, extra = {}) {
        const details = Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[Realtime] session=${sessionId} stage=${stage} ${details}`.trim());
    }

    function emit(payload) {
        if (socketClosed || socket.destroyed) return false;
        if (payload.type === 'session.ready') {
            readySent = true;
        }
        return sendJson(socket, {
            session_id: sessionId,
            server_time_ms: Date.now(),
            ...payload,
        });
    }

    // One visual lifecycle per realtime connection. It consumes the same
    // authoritative generation ids for Gemini, Grok and mock providers.
    const visualOrchestrator = createVisualOrchestrator({ emit, log });

    function rememberTurn(role, text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        recentTurns.push({ role, text: clean.slice(0, 240) });
        while (recentTurns.length > 12) recentTurns.shift();
    }

    function buildPromptBundle() {
        return buildRealtimeSystemInstruction({
            ...promptBlocks,
            currentContext: {
                mode: currentMode,
                sessionLanguage: sessionLanguage || 'auto',
                languageInstruction: sessionLanguage
                    ? `Continue in the last clearly understood language: ${sessionLanguage}. Keep the same voice identity.`
                    : 'No stable language has been established yet. Follow the last clearly understood utterance.',
                recentTurns,
                localDateTime: cachedLocalDateTime,
                sessionMemory: sessionMemory ? sessionMemory.formatForPrompt() : null,
            },
        });
    }

    function buildProviderSessionOptions(rotationReason) {
        const prompt = buildPromptBundle();
        return {
            voiceName: sessionVoiceName || undefined,
            voiceConfigSource: sessionVoiceConfigSource,
            systemInstructionText: prompt.text,
            systemInstructionMeta: prompt.meta,
            promptSource,
            rotationReason,
            rotationMode,
            contentToolsEnabled,
            toolDeclarations: contentToolsEnabled ? toolDeclarations : [],
            toolHandlers: contentToolsEnabled ? toolHandlers : {},
        };
    }

    function safePromptPayload() {
        const prompt = buildPromptBundle();
        return {
            allow_custom_prompt: DASHBOARD_ALLOW_CUSTOM_PROMPT,
            max_chars: PROMPT_MAX_CHARS,
            source: promptSource,
            // Full block text is UNCONDITIONALLY omitted here — this function
            // only feeds session.ready, emitted right after the socket
            // connects, before the client has sent session.start (and
            // therefore before promptDebugRequested is known) at all.
            current_context: prompt.blocks.currentContext,
            meta: prompt.meta,
        };
    }

    function emitPromptApplied(reason) {
        const prompt = buildPromptBundle();
        emit({
            type: 'session.config.applied',
            reason,
            prompt_source: promptSource,
            // Non-silent surface for the microphone input sample-rate the
            // server is using for THIS connection — lets a client that
            // forgot to send sampleRate see explicitly what was assumed,
            // instead of the assumption being invisible.
            input_audio: {
                sample_rate: inputSampleRate,
                sample_rate_source: inputSampleRateSource,
                gemini_input_sample_rate: GEMINI_INPUT_SAMPLE_RATE,
            },
            prompt_debug: {
                allow_custom_prompt: DASHBOARD_ALLOW_CUSTOM_PROMPT,
                max_chars: PROMPT_MAX_CHARS,
                current_context: prompt.blocks.currentContext,
                meta: prompt.meta,
                // Actual text applied to this session — lets the dashboard's
                // Persona/Diagnostics panels show what's really driving the
                // model instead of only hashes. Only sent when the client
                // explicitly asked for it (promptDebugRequested) — the full
                // combined text can be tens of KB.
                ...(promptDebugRequested ? { applied_blocks: {
                    persona: prompt.blocks.persona,
                } } : {}),
            },
        });
        log('prompt_config_applied', {
            reason,
            promptSource,
            promptChars: prompt.meta.promptChars,
            promptHash: prompt.meta.promptHash,
            personaChars: prompt.meta.persona.chars,
            personaHash: prompt.meta.persona.hash,
            currentContextChars: prompt.meta.currentContext.chars,
            currentContextHash: prompt.meta.currentContext.hash,
        });
    }

    function scheduleLanguageSwitch(previousLanguage, nextLanguage, generation, signal, reason, confirmationCount) {
        sessionLanguage = nextLanguage;
        pendingLanguageSwitch = {
            from: previousLanguage,
            to: nextLanguage,
            detectedAt: Date.now(),
            generationId: generation?.generationId || null,
            turnId: generation?.turnId || null,
        };
        pendingLanguageCandidate = null;
        log('language_switch_detected', {
            generationId: generation?.generationId || 'none',
            turnId: generation?.turnId || 'none',
            from: previousLanguage,
            to: nextLanguage,
            significantWordCount: signal.significantWordCount,
            confirmationCount,
            reason,
            action: 'rotate_before_next_turn',
        });
        emit({
            type: 'language.switch_detected',
            from_language: previousLanguage,
            to_language: nextLanguage,
            generation_id: generation?.generationId || null,
            turn_id: generation?.turnId || null,
            significant_word_count: signal.significantWordCount,
            confirmation_count: confirmationCount,
            reason,
            action: 'rotate_before_next_turn',
        });
    }

    function noteUserLanguage(text, generation) {
        const signal = detectLanguageSignal(text);
        if (!signal) return;
        const detectedLanguage = signal.language;
        const previousLanguage = sessionLanguage;
        if (!previousLanguage) {
            if (!signal.confident) {
                pendingLanguageCandidate = pendingLanguageCandidate?.language === detectedLanguage
                    ? { language: detectedLanguage, count: pendingLanguageCandidate.count + 1 }
                    : { language: detectedLanguage, count: 1 };
                if (pendingLanguageCandidate.count < LANGUAGE_SWITCH_CONFIRMATIONS) {
                    log('language_candidate_waiting', {
                        generationId: generation?.generationId || 'none',
                        turnId: generation?.turnId || 'none',
                        language: detectedLanguage,
                        significantWordCount: signal.significantWordCount,
                        confirmationCount: pendingLanguageCandidate.count,
                        action: 'wait_for_confirmation',
                    });
                    return;
                }
            }
            sessionLanguage = detectedLanguage;
            pendingLanguageCandidate = null;
            log('language_detected', {
                generationId: generation?.generationId || 'none',
                turnId: generation?.turnId || 'none',
                language: detectedLanguage,
                significantWordCount: signal.significantWordCount,
                confirmationCount: signal.confident ? 1 : LANGUAGE_SWITCH_CONFIRMATIONS,
                action: signal.confident ? 'set_initial' : 'set_initial_confirmed',
            });
            return;
        }
        if (previousLanguage === detectedLanguage) {
            pendingLanguageCandidate = null;
            return;
        }
        if (signal.confident) {
            scheduleLanguageSwitch(previousLanguage, detectedLanguage, generation, signal, 'confident_transcript', 1);
            return;
        }
        pendingLanguageCandidate = pendingLanguageCandidate?.from === previousLanguage && pendingLanguageCandidate?.to === detectedLanguage
            ? { from: previousLanguage, to: detectedLanguage, count: pendingLanguageCandidate.count + 1 }
            : { from: previousLanguage, to: detectedLanguage, count: 1 };
        log('language_switch_candidate', {
            generationId: generation?.generationId || 'none',
            turnId: generation?.turnId || 'none',
            from: previousLanguage,
            to: detectedLanguage,
            significantWordCount: signal.significantWordCount,
            confirmationCount: pendingLanguageCandidate.count,
            action: 'wait_for_confirmation',
        });
        if (pendingLanguageCandidate.count >= LANGUAGE_SWITCH_CONFIRMATIONS) {
            scheduleLanguageSwitch(
                previousLanguage,
                detectedLanguage,
                generation,
                signal,
                'consecutive_confirmation',
                pendingLanguageCandidate.count,
            );
        }
    }

    function applyPendingLanguageSwitchBeforeInput() {
        if (!pendingLanguageSwitch) return;
        const languageSwitch = pendingLanguageSwitch;
        pendingLanguageSwitch = null;
        log('language_switch_rotation_started', {
            from: languageSwitch.from,
            to: languageSwitch.to,
            previousGenerationId: languageSwitch.generationId || 'none',
            previousTurnId: languageSwitch.turnId || 'none',
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        rotateProviderSession('language_switch');
        warmProviderSession('language_switch').catch((error) => {
            log('provider_warm_error', {
                reason: 'language_switch',
                message: error.message,
            });
        });
    }

    function droppedProviderEvent(generation, eventType, reason) {
        lateProviderEventsDropped += 1;
        log('dropped_provider_event', {
            generationId: generation?.generationId || 'none',
            responseId: generation?.responseId || 'none',
            eventType,
            reason,
            lateProviderEventsDropped,
        });
    }

    function clearGenerationTimeout(generation) {
        if (!generation?.timeoutTimer) return;
        clearTimeout(generation.timeoutTimer);
        generation.timeoutTimer = null;
    }

    function armPttTurnTimeout(generation) {
        if (!generation || currentMode !== 'push_to_talk') return;
        clearGenerationTimeout(generation);
        const timeoutMs = Math.max(0, Number(process.env.PTT_TURN_TIMEOUT_MS || 4500));
        if (timeoutMs <= 0) return;
        generation.timeoutTimer = setTimeout(() => {
            if (
                generation.status === 'pending'
                && !generation.responseCreatedSent
                && !generation.cancel.cancelled
            ) {
                recoverFromTurnTimeout(generation, timeoutMs).catch((error) => {
                    log('turn_timeout_recovery_error', {
                        generationId: generation.generationId,
                        turnId: generation.turnId,
                        message: error.message,
                    });
                });
            }
        }, timeoutMs);
    }

    function buildProviderContext(generation) {
        return {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            mode: currentMode,
            signal: generation.cancel,
            onSessionEvent: (event) => emit(event),
            isGenerationActive: () => (
                currentGeneration === generation
                && generation.status !== 'cancelled'
                && generation.status !== 'completed'
                && generation.status !== 'failed'
                && !generation.cancel.cancelled
            ),
            onEvent: (event) => emitProviderEvent(generation, event),
            onAudioChunk: (event) => emitProviderEvent(generation, event),
            log,
        };
    }

    async function warmProviderSession(reason) {
        if (typeof providerSession?.connect !== 'function') return;
        await providerSession.connect(log);
        promptApplyCount += 1;
        log('provider_ready', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            rotationMode,
            promptApplyCount,
        });
        log('provider_voice_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            configSource: providerSession.voiceConfigSource || sessionVoiceConfigSource,
            inheritedFromPreviousProvider: reason !== 'initial',
            rotationReason: reason,
            rotationMode,
            providerRotationCount,
            promptApplyCount,
        });
        log('provider_prompt_config', {
            clientSessionId: sessionId,
            providerInstanceId: providerSession.instanceId || 'unknown',
            promptSource: providerSession.promptSource || promptSource,
            rotationReason: providerSession.rotationReason || reason,
            promptChars: providerSession.systemInstructionMeta?.promptChars || 0,
            promptHash: providerSession.systemInstructionMeta?.promptHash || 'none',
            personaChars: providerSession.systemInstructionMeta?.persona?.chars || 0,
            personaHash: providerSession.systemInstructionMeta?.persona?.hash || 'none',
            rotationMode,
            providerRotationCount,
            promptApplyCount,
            currentContextChars: providerSession.systemInstructionMeta?.currentContext?.chars || 0,
            currentContextHash: providerSession.systemInstructionMeta?.currentContext?.hash || 'none',
        });
        emit({
            type: 'provider.ready',
            reason,
            provider: providerSession.name || 'provider',
            provider_instance_id: providerSession.instanceId || null,
        });
    }

    async function recoverFromTurnTimeout(generation, timeoutMs) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'ptt_turn_timeout', 'stale_generation');
            return;
        }
        generation.timeoutLogged = true;
        generation.status = 'failed';
        generation.cancel.cancel('provider_timeout');
        clearGenerationTimeout(generation);
        log('ptt_turn_timeout', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            timeoutMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
        });
        emit({
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason: 'provider_timeout',
            timeout_ms: timeoutMs,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
        });
    }

    async function recoverFromProviderFailure(generation, reason, payload = {}) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'response.failed', 'stale_generation');
            return;
        }
        // Audio turns can be replayed from currentInputChunks. Text turns are
        // not silently replayed because that could duplicate a sensitive
        // red-team prompt after the provider already accepted it.
        if (currentMode !== 'text' && await retryGenerationOnFreshProvider(generation, reason)) {
            return;
        }
        generation.status = 'failed';
        generation.cancel.cancel(reason);
        clearGenerationTimeout(generation);
        log('response_failed', {
            generationId: generation.generationId,
            responseId: generation.responseId,
            turnId: generation.turnId,
            reason,
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        emit({
            ...payload,
            type: 'response.failed',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            reason,
        });

        const startedAt = Date.now();
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        log('turn_timeout_recovery_started', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            reason,
        });
        rotateProviderSession(reason);
        await warmProviderSession(reason);
        log('turn_timeout_recovery_completed', {
            failedGenerationId: generation.generationId,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            elapsedMs: Date.now() - startedAt,
            reason,
        });
    }

    async function retryGenerationOnFreshProvider(generation, reason) {
        const retryableReasons = new Set([
            'provider_turn_closed_before_output',
            'provider_turn_closed_during_input',
        ]);
        if (!retryableReasons.has(reason)) return false;
        if (generation.providerRetryAttempted) return false;
        if (!generation.inputEndedAt) return false;
        if (generation.responseCreatedSent) return false;
        if (currentInputChunks.length === 0 || currentInputBufferedBytes <= 0) return false;
        if (generation.cancel.cancelled || generation.status === 'cancelled' || generation.status === 'completed') return false;

        generation.providerRetryAttempted = true;
        clearGenerationTimeout(generation);
        const oldProviderInstanceId = providerSession?.instanceId || 'unknown';
        const startedAt = Date.now();
        log('provider_turn_retry_started', {
            generationId: generation.generationId,
            turnId: generation.turnId,
            reason,
            oldProviderInstanceId,
            replayChunks: currentInputChunks.length,
            replayBytes: currentInputBufferedBytes,
        });

        rotateProviderSession(reason);
        generation.cancel = createCancellation();
        generation.status = 'pending';
        const retryContext = buildProviderContext(generation);
        if (typeof providerSession.beginResponse === 'function') {
            providerSession.beginResponse(retryContext);
        }
        for (const chunk of currentInputChunks) {
            if (generation !== currentGeneration || generation.cancel.cancelled) {
                droppedProviderEvent(generation, 'provider_retry_audio', 'stale_generation');
                return true;
            }
            providerSession.sendAudio(chunk);
        }
        armPttTurnTimeout(generation);
        providerSession.endInput(retryContext).catch((error) => {
            recoverFromProviderFailure(generation, 'provider_retry_error', {
                type: 'response.failed',
                reason: 'provider_retry_error',
                message: error.message,
            }).catch((recoveryError) => {
                log('turn_retry_recovery_error', {
                    generationId: generation.generationId,
                    turnId: generation.turnId,
                    message: recoveryError.message,
                });
            });
        });
        log('provider_turn_retry_dispatched', {
            generationId: generation.generationId,
            turnId: generation.turnId,
            reason,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession?.instanceId || 'unknown',
            replayChunks: currentInputChunks.length,
            replayBytes: currentInputBufferedBytes,
            elapsedMs: Date.now() - startedAt,
        });
        return true;
    }

    function emitResponseCreated(generation, cause) {
        if (!generation || generation.responseCreatedSent) return;
        if (generation.status === 'cancelled' || generation.status === 'completed') {
            droppedProviderEvent(generation, 'response.created', 'terminal_generation');
            return;
        }
        generation.responseId = generation.responseId || id('response');
        clearGenerationTimeout(generation);
        generation.responseCreatedSent = true;
        generation.status = 'active';
        emit({
            type: 'response.created',
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
            cause,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
        });
    }

    function emitProviderEvent(generation, payload) {
        if (!generation) return false;
        const eventType = payload?.type || 'unknown';
        const modelOutputEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk', 'audio.end']);
        const startsGenerationEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk']);
        if (eventType === 'provider_interrupt_ack') {
            return emit(payload);
        }
        if (eventType === 'provider.dropped_event') {
            droppedProviderEvent(generation, payload.event_type || 'unknown', payload.reason || 'provider_dropped_event');
            return true;
        }
        if (eventType === 'response.failed') {
            visualOrchestrator.cancel(generation.generationId, payload.reason || 'provider_failed');
            recoverFromProviderFailure(generation, payload.reason || 'provider_failed', payload).catch((error) => {
                log('turn_timeout_recovery_error', {
                    generationId: generation.generationId,
                    turnId: generation.turnId,
                    message: error.message,
                });
            });
            return true;
        }
        if (generation.status === 'cancelled' || generation.status === 'completed' || generation.status === 'failed') {
            if (modelOutputEvents.has(eventType)) {
                droppedProviderEvent(generation, eventType, 'terminal_generation');
            }
            return false;
        }
        if (eventType === 'transcript.user') {
            // Gemini streams inputTranscription as incremental fragments, not one
            // final string — accumulate every fragment for this generation so
            // memory extraction (triggered later, at audio.end) sees the full
            // user turn, not just the first partial chunk.
            generation.userTranscriptBuffer += String(payload.text || '');
            visualOrchestrator.noteUserText(generation.generationId, payload.text);
        }
        if (eventType === 'transcript.user' && generation.inputEndedAt && !generation.firstInputTranscriptionAt) {
            rememberTurn('user', payload.text);
            noteUserLanguage(payload.text, generation);
            generation.firstInputTranscriptionAt = Date.now();
            log('provider_input_transcription_received', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,
            });
        }
        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {
            generation.firstModelEventAt = Date.now();
            log('provider_first_model_event', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                eventType,
                inputEndToFirstModelEventMs: generation.firstModelEventAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'audio.start' && generation.inputEndedAt && !generation.firstValidAudioAt) {
            generation.firstValidAudioAt = Date.now();
            log('provider_first_valid_audio', {
                generationId: generation.generationId,
                turnId: generation.turnId,
                inputEndToFirstValidAudioMs: generation.firstValidAudioAt - generation.inputEndedAt,
            });
        }
        if (eventType === 'transcript.model') {
            assistantTranscriptBuffer += String(payload.text || '');
        }
        if (startsGenerationEvents.has(eventType)) {
            emitResponseCreated(generation, eventType);
        }
        if (eventType === 'response.cancelled') {
            generation.status = 'cancelled';
            clearGenerationTimeout(generation);
            assistantTranscriptBuffer = '';
        }
        const shouldRotateAfterAudioEnd = eventType === 'audio.end' && shouldRotateProviderAfterOutputComplete();
        if (eventType === 'audio.end') {
            generation.status = 'completed';
            clearGenerationTimeout(generation);
            rememberTurn('assistant', assistantTranscriptBuffer);
            assistantTranscriptBuffer = '';
        }
        const emitted = emit({
            ...payload,
            generation_id: generation.generationId,
            response_id: generation.responseId,
            turn_id: generation.turnId,
        });
        if (eventType === 'audio.start') {
            visualOrchestrator.onAudioStart(generation.generationId);
        } else if (eventType === 'audio.end') {
            visualOrchestrator.onAudioEnd(generation.generationId);
        } else if (eventType === 'response.cancelled') {
            visualOrchestrator.cancel(generation.generationId, payload.reason || 'provider_cancelled');
        }
        if (shouldRotateAfterAudioEnd && generation === currentGeneration) {
            rotateProviderSession(payload.cause === 'turnComplete'
                ? 'output_turn_complete'
                : 'output_generation_complete');
            warmProviderSession('output_complete').catch((error) => {
                log('provider_warm_error', {
                    reason: 'output_complete',
                    message: error.message,
                });
            });
        } else if (eventType === 'audio.end' && generation === currentGeneration && rotationMode === 'errors_only') {
            providerSessionReuseCount += 1;
            log('provider_session_reused', {
                reason: payload.cause || 'audio_end',
                providerInstanceId: providerSession?.instanceId || 'unknown',
                providerSessionReuseCount,
                providerRotationCount,
                promptApplyCount,
                turnCount: turnCounter,
                lateProviderEventsDropped,
            });
        }
        return emitted;
    }

    function cancelCurrent(reason) {
        if (
            !currentGeneration
            || currentGeneration.status === 'cancelled'
            || currentGeneration.status === 'completed'
            || currentGeneration.status === 'failed'
        ) return false;
        const cancelRequestedAt = Date.now();
        currentGeneration.cancel.cancel(reason);
        providerSession.interrupt(reason, {
            interrupted_generation_id: currentGeneration.generationId,
            interrupted_turn_id: currentGeneration.turnId,
            interrupted_response_id: currentGeneration.responseId,
            provider_instance_id: providerSession.instanceId || null,
            interrupt_requested_at: cancelRequestedAt,
        });
        currentGeneration.status = 'cancelled';
        clearGenerationTimeout(currentGeneration);
        visualOrchestrator.cancel(currentGeneration.generationId, reason);
        const cancelLatencyMs = Date.now() - cancelRequestedAt;
        emit({
            type: 'response.cancelled',
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            turn_id: currentGeneration.turnId,
            reason,
            cancel_latency_ms: cancelLatencyMs,
        });
        log('response_cancelled', {
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            turnId: currentGeneration.turnId,
            reason,
            cancelLatencyMs,
        });
        return true;
    }

    function rotateProviderSession(reason) {
        providerRotationCount += 1;
        const oldProviderSession = providerSession;
        const oldProviderInstanceId = oldProviderSession?.instanceId || 'unknown';
        const oldProviderVoiceName = oldProviderSession?.voiceName || sessionVoiceName || 'none';
        try {
            if (typeof oldProviderSession.destroySession === 'function') {
                oldProviderSession.destroySession(reason);
            } else {
                oldProviderSession.close();
            }
        } catch (error) {
            log('provider_rotation_close_error', {
                reason,
                providerInstanceId: oldProviderInstanceId,
                message: error.message,
            });
        }
        providerSession = providerFactory(buildProviderSessionOptions(reason));
        const oldPromptMeta = oldProviderSession?.systemInstructionMeta || {};
        const newPromptMeta = providerSession.systemInstructionMeta || {};
        log('provider_session_rotated', {
            reason,
            oldProviderInstanceId,
            newProviderInstanceId: providerSession.instanceId || 'unknown',
            provider: providerSession.name || 'provider',
            oldProviderVoiceName,
            newProviderVoiceName: providerSession.voiceName || sessionVoiceName || 'none',
            voicePreserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            oldPromptHash: oldPromptMeta.promptHash || 'none',
            newPromptHash: newPromptMeta.promptHash || 'none',
            personaPreserved: oldPromptMeta.persona?.hash === newPromptMeta.persona?.hash,
            rotationMode,
            providerRotationCount,
            providerSessionReuseCount,
            promptApplyCount,
        });
        emit({
            type: 'provider.rotated',
            reason,
            old_provider_instance_id: oldProviderInstanceId,
            new_provider_instance_id: providerSession.instanceId || null,
            provider: providerSession.name || 'provider',
            old_provider_voice_name: oldProviderVoiceName,
            new_provider_voice_name: providerSession.voiceName || sessionVoiceName || null,
            voice_preserved: oldProviderVoiceName === (providerSession.voiceName || sessionVoiceName || 'none'),
            old_prompt_hash: oldPromptMeta.promptHash || null,
            new_prompt_hash: newPromptMeta.promptHash || null,
            persona_hash: newPromptMeta.persona?.hash || null,
            persona_preserved: oldPromptMeta.persona?.hash === newPromptMeta.persona?.hash,
            rotation_mode: rotationMode,
            provider_rotation_count: providerRotationCount,
            provider_session_reuse_count: providerSessionReuseCount,
            prompt_apply_count: promptApplyCount,
        });
    }

    function shouldRotateProviderOnInterrupt() {
        return Boolean(providerSession?.rotateOnInterrupt);
    }

    function shouldRotateProviderAfterOutputComplete() {
        return rotationMode === 'per_turn' && Boolean(providerSession?.rotateAfterOutputComplete);
    }

    function closeProvider(reason) {
        if (providerClosed) return;
        providerClosed = true;
        inputResampler.reset();
        cancelCurrent(reason);
        providerSession.close();
        log('provider_session_closed', {
            reason,
            provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
        });
    }

    function startInput(payload = {}) {
        applyPendingLanguageSwitchBeforeInput();
        assistantTranscriptBuffer = '';
        const cancelledActiveGeneration = cancelCurrent('new_input');
        if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
            rotateProviderSession('new_input_after_cancel');
        }
        turnCounter += 1;
        currentTurnId = payload.turn_id || id(`turn${turnCounter}`);
        currentGeneration = createGeneration({ turnId: currentTurnId });
        visualOrchestrator.beginGeneration({
            generationId: currentGeneration.generationId,
            turnId: currentTurnId,
        });
        currentMode = payload.mode || 'push_to_talk';
        inputStartedAt = Date.now();
        inputEndedAt = 0;
        inputBytes = 0;
        currentInputChunks = [];
        currentInputBufferedBytes = 0;
        // Fresh resampler state for this turn — filter history/interpolation
        // position from a previous turn must never bleed into this one.
        inputResampler.reset();
        emit({
            type: 'input_audio.start',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: null,
        });
        const generationForStream = currentGeneration;
        const responseIdForStream = currentGeneration.responseId;
        const turnIdForStream = currentTurnId;
        if (typeof providerSession.beginResponse === 'function') {
            providerSession.beginResponse({
                generationId: generationForStream.generationId,
                responseId: responseIdForStream,
                turnId: turnIdForStream,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                mode: currentMode,
                signal: generationForStream.cancel,
                onSessionEvent: (event) => emit(event),
                isGenerationActive: () => (
                    currentGeneration === generationForStream
                    && generationForStream.status !== 'cancelled'
                    && generationForStream.status !== 'completed'
                    && !generationForStream.cancel.cancelled
                ),
                onEvent: (event) => emitProviderEvent(generationForStream, event),
                onAudioChunk: (event) => emitProviderEvent(generationForStream, event),
                log,
            });
        }
        log('input_audio_start', {
            turnId: currentTurnId,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            mode: currentMode,
            rotationMode,
            turnCount: turnCounter,
        });
    }

    function endInput(payload = {}) {
        if (!currentTurnId || !inputStartedAt) {
            emit({
                type: 'error',
                code: 'input_not_started',
                message: 'input_audio.end received before input_audio.start',
            });
            return;
        }

        // Drain the resampler's FIR tail (a few samples always remain
        // buffered internally waiting for enough history to filter) BEFORE
        // resetting its state — otherwise the last handful of milliseconds
        // of every turn would be silently dropped. Only meaningful at
        // 24000Hz input; at 16000 flush() is a no-op returning empty.
        try {
            const tail = inputResampler.flush();
            if (tail.length > 0) {
                inputBytes += tail.length;
                sessionInputBytes += tail.length;
                if (currentInputBufferedBytes + tail.length <= MAX_TURN_REPLAY_BYTES) {
                    currentInputChunks.push(tail);
                    currentInputBufferedBytes += tail.length;
                }
                providerSession.sendAudio(tail);
                log('input_audio_tail_flushed', {
                    turnId: currentTurnId,
                    tailBytes: tail.length,
                });
            }
        } catch (error) {
            log('input_resample_flush_error', { turnId: currentTurnId, message: error.message });
            emit({
                type: 'error',
                code: 'input_resample_error',
                turn_id: currentTurnId,
                message: error.message,
            });
        } finally {
            inputResampler.reset();
        }

        inputEndedAt = Date.now();
        const recordingDurationMs = inputEndedAt - inputStartedAt;
        if (!currentGeneration) {
            currentGeneration = createGeneration({ turnId: currentTurnId });
        }

        emit({
            type: 'input_audio.end',
            turn_id: currentTurnId,
            generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId,
            duration_ms: recordingDurationMs,
            turn_input_bytes: inputBytes,
            session_input_bytes: sessionInputBytes,
            end_reason: payload.end_reason || null,
        });
        visualOrchestrator.markThinking(currentGeneration.generationId);
        log('input_audio_end', {
            turnId: currentTurnId,
            durationMs: recordingDurationMs,
            turnInputBytes: inputBytes,
            sessionInputBytes,
            generationId: currentGeneration.generationId,
            responseId: currentGeneration.responseId,
            endReason: payload.end_reason || 'unknown',
        });

        const generationForStream = currentGeneration;
        generationForStream.inputEndedAt = inputEndedAt;
        armPttTurnTimeout(generationForStream);

        const endInputContext = buildProviderContext(generationForStream);

        providerSession.endInput(endInputContext).catch((error) => {
            emit({
                type: 'error',
                generation_id: generationForStream.generationId,
                response_id: generationForStream.responseId,
                turn_id: generationForStream.turnId,
                code: 'provider_error',
                provider: providerSession.name || 'provider',
                message: error.message,
            });
            log('provider_error', {
                provider: providerSession.name || 'provider',
                message: error.message,
            });
        });
    }

    function submitTextInput(payload = {}) {
        const text = String(payload.text || '').trim();
        if (!text) {
            emit({ type: 'error', code: 'input_text_empty', message: 'Text input must not be empty.' });
            return;
        }
        if (text.length > 1200) {
            emit({
                type: 'error',
                code: 'input_text_too_long',
                message: 'Text input must be 1200 characters or fewer.',
                max_chars: 1200,
                chars: text.length,
            });
            return;
        }
        if (typeof providerSession.sendText !== 'function') {
            emit({ type: 'error', code: 'text_input_unsupported', message: 'The active provider does not support text input.' });
            return;
        }

        startInput({
            turn_id: payload.turn_id,
            mode: 'text',
        });
        inputEndedAt = Date.now();
        const generationForText = currentGeneration;
        generationForText.inputEndedAt = inputEndedAt;
        emit({
            type: 'input_text.submitted',
            turn_id: currentTurnId,
            generation_id: generationForText.generationId,
            response_id: generationForText.responseId,
            text,
            chars: text.length,
        });
        emitProviderEvent(generationForText, {
            type: 'transcript.user',
            response_id: generationForText.responseId,
            turn_id: currentTurnId,
            text,
        });
        visualOrchestrator.markThinking(generationForText.generationId);
        armPttTurnTimeout(generationForText);
        const textContext = buildProviderContext(generationForText);
        providerSession.sendText(text, textContext).catch((error) => {
            emit({
                type: 'error',
                generation_id: generationForText.generationId,
                response_id: generationForText.responseId,
                turn_id: generationForText.turnId,
                code: 'provider_error',
                provider: providerSession.name || 'provider',
                message: error.message,
            });
            generationForText.status = 'failed';
            generationForText.cancel.cancel('provider_text_input_error');
            emit({
                type: 'response.failed',
                generation_id: generationForText.generationId,
                response_id: generationForText.responseId,
                turn_id: generationForText.turnId,
                reason: 'provider_text_input_error',
            });
        });
        log('input_text_submitted', {
            turnId: currentTurnId,
            generationId: generationForText.generationId,
            chars: text.length,
        });
    }

    function handleCommand(raw) {
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (error) {
            emit({
                type: 'error',
                code: 'invalid_json',
                message: 'Invalid JSON command',
            });
            return;
        }

        if (payload.type === 'session.start') {
            if (
                currentGeneration
                && !['completed', 'cancelled', 'failed'].includes(currentGeneration.status)
            ) {
                emit({
                    type: 'error',
                    code: 'session_config_busy',
                    message: 'Prompt config can be changed only while the realtime session is idle.',
                });
                return;
            }
            // Microphone input sample-rate gate: an explicit, unsupported
            // rate is rejected outright (never guessed). A MISSING rate
            // falls back to 16000 pass-through for backward compatibility
            // with clients that predate this field, but that fallback is
            // never silent — logged here and echoed back in
            // session.config.applied's input_audio block below.
            try {
                const resolved = resolveInputSampleRate(payload);
                inputSampleRate = resolved.rate;
                inputSampleRateSource = resolved.source;
                inputResampler = createInputResampler(inputSampleRate);
                log('input_sample_rate_configured', {
                    rate: inputSampleRate,
                    source: inputSampleRateSource,
                });
            } catch (error) {
                emit({
                    type: 'error',
                    code: error.code || 'unsupported_input_sample_rate',
                    message: `Unsupported sampleRate ${error.requestedRate} in session.start. Supported values: 16000, 24000.`,
                });
                log('input_sample_rate_rejected', { requestedRate: error.requestedRate });
                return;
            }
            // Explicit opt-in only — see the promptDebugRequested declaration
            // above for why this must never be silently assumed true.
            promptDebugRequested = payload.include_prompt_debug === true;
            // Explicit client-supplied language preference (e.g. a
            // dashboard language selector), sitting alongside the existing
            // transcript-based auto-detection in noteUserLanguage() —
            // whichever set sessionLanguage more recently wins, same as a
            // detected switch mid-conversation. Deliberately just a shape
            // check (2-letter code), not a fixed language list: this file
            // stays domain-agnostic, so it doesn't import the persona
            // module's SUPPORTED_LANGUAGES to validate against.
            if (typeof payload.language === 'string' && /^[a-z]{2}$/i.test(payload.language)) {
                sessionLanguage = payload.language.toLowerCase();
                log('session_language_set_explicit', { language: sessionLanguage });
            }
            (async () => {
                try {
                    const sanitized = sanitizePromptConfig(payload.config || {}, {
                        allowCustomPrompt: DASHBOARD_ALLOW_CUSTOM_PROMPT,
                    });
                    promptBlocks = sanitized.blocks;
                    promptSource = sanitized.source;
                    cachedLocalDateTime = formatLocalDateTime(DEFAULT_TIMEZONE, new Date());

                    if (payload.voiceName) {
                        const requestedVoice = normalizeProviderVoiceName(payload.voiceName);
                        if (requestedVoice && requestedVoice !== sessionVoiceName) {
                            sessionVoiceName = requestedVoice;
                            sessionVoiceConfigSource = 'session_start';
                            log('session_voice_applied', { voiceName: sessionVoiceName });
                        }
                    }

                    rotateProviderSession('session_start_config');
                    emitPromptApplied('session.start');
                } catch (error) {
                    emit({
                        type: 'error',
                        code: 'prompt_config_invalid',
                        message: error.code || error.message,
                        max_chars: error.maxChars || PROMPT_MAX_CHARS,
                        chars: error.chars || 0,
                    });
                    log('prompt_config_invalid', {
                        message: error.code || error.message,
                        maxChars: error.maxChars || PROMPT_MAX_CHARS,
                        chars: error.chars || 0,
                    });
                }
            })();
            log('session_start_received');
        } else if (payload.type === 'input_audio.start') {
            startInput(payload);
        } else if (payload.type === 'input_audio.end') {
            endInput(payload);
        } else if (payload.type === 'input_text.submit') {
            submitTextInput(payload);
        } else if (payload.type === 'session.interrupt') {
            const reason = payload.reason || 'client_interrupt';
            inputResampler.reset();
            const cancelledActiveGeneration = cancelCurrent(reason);
            if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) {
                rotateProviderSession(reason);
            }
        } else if (payload.type === 'ping') {
            emit({
                type: 'pong',
                timestamp_ms: payload.timestamp_ms || Date.now(),
            });
        } else {
            emit({
                type: 'error',
                code: 'unknown_command',
                message: `Unknown command type: ${payload.type || 'missing'}`,
            });
        }
    }

    const parser = createFrameParser({
        onText: handleCommand,
        onBinary(payload) {
            if (
                !currentGeneration
                || !inputStartedAt
                || inputEndedAt
                || currentGeneration.status === 'completed'
                || currentGeneration.status === 'cancelled'
                || currentGeneration.status === 'failed'
            ) {
                log('dropped_input_audio_frame', {
                    reason: 'no_active_input',
                    bytes: payload.length,
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                    providerInstanceId: providerSession?.instanceId || 'unknown',
                });
                return;
            }
            // Resample 24000Hz ESP32 input down to Gemini's 16000Hz before
            // anything downstream sees it (byte counters, the replay buffer
            // used by retryGenerationOnFreshProvider(), and the provider
            // itself all operate on the POST-resample stream — replaying
            // raw 24kHz bytes into Gemini on retry would be just as wrong
            // as sending them the first time). At 16000 this is a
            // byte-identical pass-through.
            let resampled;
            try {
                resampled = inputResampler.process(payload);
            } catch (error) {
                inputResampler.reset();
                log('input_resample_error', {
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                    message: error.message,
                });
                emit({
                    type: 'error',
                    code: 'input_resample_error',
                    generation_id: currentGeneration?.generationId,
                    turn_id: currentTurnId,
                    message: error.message,
                });
                return;
            }
            if (resampled.length === 0) return; // buffered internally, nothing to forward yet
            inputBytes += resampled.length;
            sessionInputBytes += resampled.length;
            if (currentInputBufferedBytes + resampled.length <= MAX_TURN_REPLAY_BYTES) {
                currentInputChunks.push(resampled);
                currentInputBufferedBytes += resampled.length;
            } else if (currentInputBufferedBytes <= MAX_TURN_REPLAY_BYTES) {
                log('input_replay_buffer_full', {
                    bytes: resampled.length,
                    bufferedBytes: currentInputBufferedBytes,
                    maxReplayBytes: MAX_TURN_REPLAY_BYTES,
                    turnId: currentTurnId || 'none',
                    generationId: currentGeneration?.generationId || 'none',
                });
                currentInputBufferedBytes = MAX_TURN_REPLAY_BYTES + 1;
                currentInputChunks = [];
            }
            providerSession.sendAudio(resampled);
            log('input_audio_frame', {
                turnId: currentTurnId || 'none',
                bytes: payload.length,
                resampledBytes: resampled.length,
                turnInputBytes: inputBytes,
                sessionInputBytes,
                provider: providerSession.name || 'provider',
                providerInstanceId: providerSession.instanceId || 'unknown',
            });
        },
        onPing(payload) {
            sendPong(socket, payload);
        },
        onClose() {
            closeProvider('client_close');
            sendClose(socket);
        },
        onError(error) {
            emit({
                type: 'error',
                code: 'ws_parse_error',
                message: error.message,
            });
        },
    });

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (error) => {
        closeProvider('socket_error');
        log('socket_error', { message: error.message });
    });
    socket.on('close', () => {
        socketClosed = true;
        if (currentGeneration) visualOrchestrator.cancel(currentGeneration.generationId, 'disconnect');
        closeProvider('disconnect');
        log('disconnect', { connectedMs: Date.now() - connectedAt });
    });

    emit({
        type: 'session.ready',
        session_id: sessionId,
        provider: providerSession.name || 'mock',
        provider_instance_id: providerSession.instanceId || null,
        rotation_mode: rotationMode,
        model: providerMetadata.model || null,
        config: DEFAULT_CONFIG,
        prompt_debug: safePromptPayload(),
    });
    log('session_ready', {
        provider: providerSession.name || 'mock',
        providerInstanceId: providerSession.instanceId || 'unknown',
        rotationMode,
    });
}

module.exports = {
    attachRealtimeServer,
    detectLikelyLanguage,
};

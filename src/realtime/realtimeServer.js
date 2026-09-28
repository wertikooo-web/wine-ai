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
const { deriveFirstForeignWelcomeState } = require('./firstForeignWelcomePolicy');
const env = require('../config/env');
const personaStore = require('../persona/personaStore');
const { resolveProfile } = require('../persona/profileRegistry');
const { resolveProfileRuntime } = require('../persona/runtimeResolver');
const { buildProfileRuntimePrompt, CORE_PERSONA_PROMPT } = require('../persona/wineExpertPersona');
const { GEMINI_VOICES } = require('../geminiVoices');
const { GROK_VOICES } = require('../grokVoices');

function id(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

const CLIENT_TELEMETRY_ALLOWED_STAGES = new Set([
    'disconnect_clicked', 'disconnect_started', 'disconnect_completed',
    'mic_get_user_media_requested', 'mic_get_user_media_resolved',
    'mic_track_settings', 'mic_track_started', 'mic_track_stopped',
    'mic_sample_rate_unsupported', 'mic_processor_started', 'mic_processor_stopped',
    'mic_prewarm_error', 'mic_error',
    'mode_switch_started', 'mode_switch_completed', 'voice_mode_save_error',
    'playback_started', 'playback_stopped', 'playback_cancel_received',
    'playback_stop_started', 'playback_stop_completed',
    'active_sources_before', 'active_sources_after',
    'queued_chunks_before', 'queued_chunks_after',
    'pending_decodes_before', 'pending_decodes_after',
    'accepted_generation_cleared', 'stale_audio_chunk_dropped', 'pending_decode_dropped',
    'local_playback_stopped', 'socket_close_started', 'mic_stopped',
    'ptt_pressed_before_ready', 'provider_ready_for_input_received',
    'itrace_pointerdown', 'itrace_pendingPttStart_set', 'itrace_pointerup',
    'itrace_pointerup_dropped_pending_never_ready', 'itrace_pointerleave',
    'itrace_startTurn_entered', 'itrace_startTurn_exited_no_ws',
    'itrace_startTurn_exited_ok', 'itrace_startTurn_exited_mic_error',
    'itrace_ensureMic_called', 'itrace_ensureMic_already_warm',
    'itrace_ensureMic_awaiting_inflight', 'itrace_ensureMic_acquiring',
    'itrace_ensureMic_resolved_stale_interaction',
    'itrace_input_audio_start_sending', 'itrace_endTurn_entered',
    'itrace_endTurn_exited_not_holding', 'itrace_endTurn_exited_no_ws',
    'itrace_input_audio_end_sent', 'itrace_first_frame_sent',
    'itrace_provider_ready_received',
    'itrace_pendingPttStart_resolved_starting_turn',
    'itrace_pendingPttStart_resolved_already_released',
    'itrace_startTurn_exited_stale_after_audio_context',
    'itrace_startTurn_exited_audio_context_not_running',
    'itrace_audioContext_created', 'itrace_audioContext_state_before_resume',
    'itrace_audioContext_resume_started', 'itrace_audioContext_resume_completed',
    'itrace_audioContext_resume_failed', 'itrace_audioContext_state_after_resume',
    'itrace_processor_first_callback', 'itrace_first_non_silent_frame',
    'itrace_pointerdown_to_first_frame_ms', 'itrace_server_no_speech_received',
    'itrace_server_input_audio_start_received', 'itrace_input_audio_end_received',
    'itrace_client_frames_summary', 'itrace_transcript_user_received',
    'itrace_first_model_event_received', 'itrace_first_audio_chunk_received',
    'itrace_playback_started',
    'ptt_client_summary',
    'itrace_startTurn_after_audio_context', 'itrace_startTurn_after_ensureMic',
    'itrace_last_frame_sent', 'itrace_audio_frame_dropped',
]);
const CLIENT_TELEMETRY_ALLOWED_FIELDS = new Set([
    'forVoice', 'channelCount', 'sampleRate', 'echoCancellation', 'noiseSuppression', 'autoGainControl',
    'trackId', 'trackCount', 'readyState', 'enabled', 'muted', 'actual', 'message',
    'wsReadyState', 'micTrackId', 'processorLive', 'micStreamLive',
    'from', 'to', 'tapToStartActive', 'pendingTapStart', 'isHolding',
    'reason', 'generationId', 'acceptedPlaybackGenerationId', 'phase', 'count',
    'stopOperationId', 'stopDurationMs',
    'activeSourcesBefore', 'activeSourcesAfter', 'queuedChunksBefore', 'queuedChunksAfter',
    'pendingDecodesBefore', 'pendingDecodesAfter',
    'interactionId', 'turnInteractionId', 'providerReadyForInput', 'wsState',
    'hasMicStream', 'pendingPttStart', 'isPttPointerDown', 'bytes',
    'state', 'peak', 'ms', 'turnInputBytes', 'loudMs',
    'clientInstanceId', 'websocketConnectionId', 'turnId',
    'clientFrameCount', 'clientByteCount', 'eventType',
    'startSent', 'endSent', 'clientFrames', 'clientBytes', 'clientEndReason',
    'holdMs', 'frameIndex', 'lastFrameBytes', 'status', 'inputEndedAt',
    'currentGenerationId',
]);
const CLIENT_TELEMETRY_MAX_STRING_LENGTH = 200;
const CLIENT_TELEMETRY_MAX_FIELDS = 20;
const CLIENT_TELEMETRY_MAX_PAYLOAD_BYTES = 2048;
const CLIENT_TELEMETRY_RATE_LIMIT_WINDOW_MS = 10_000;
const CLIENT_TELEMETRY_RATE_LIMIT_MAX_PER_WINDOW = 200;

function sanitizeClientTelemetryData(data) {
    const out = {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    let fieldCount = 0;
    for (const key of Object.keys(data)) {
        if (fieldCount >= CLIENT_TELEMETRY_MAX_FIELDS) break;
        if (!CLIENT_TELEMETRY_ALLOWED_FIELDS.has(key)) continue;
        const value = data[key];
        const type = typeof value;
        if (type === 'string') {
            out[key] = value.length > CLIENT_TELEMETRY_MAX_STRING_LENGTH
                ? `${value.slice(0, CLIENT_TELEMETRY_MAX_STRING_LENGTH)}…(truncated)`
                : value;
            fieldCount += 1;
        } else if (type === 'number' || type === 'boolean' || value === null) {
            out[key] = value;
            fieldCount += 1;
        }
    }
    return out;
}

const VALID_ROTATION_MODES = new Set(['per_turn', 'errors_only']);
const DEFAULT_ROTATION_MODE = 'per_turn';
const configuredTurnReplayBytes = Number(process.env.REALTIME_TURN_REPLAY_MAX_BYTES);
const MAX_TURN_REPLAY_BYTES = Number.isFinite(configuredTurnReplayBytes)
    ? Math.max(0, configuredTurnReplayBytes)
    : 512 * 1024;
let warnedInvalidRotationMode = false;
function noSpeechAmplitudeThreshold() {
    const configured = Number(process.env.NO_SPEECH_AMPLITUDE_THRESHOLD);
    return Number.isFinite(configured) && process.env.NO_SPEECH_AMPLITUDE_THRESHOLD !== undefined ? configured : 200;
}
function noSpeechMinLoudMs() {
    const configured = Number(process.env.NO_SPEECH_MIN_LOUD_MS);
    return Number.isFinite(configured) && process.env.NO_SPEECH_MIN_LOUD_MS !== undefined ? configured : 60;
}
const NO_SPEECH_SAMPLE_RATE = 16000;

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

const LANGUAGE_PATTERNS = [
    { language: 'ru', pattern: /[\u0400-\u04FF]/u, weight: 3 },
    { language: 'ro', pattern: /[\u0103\u00E2\u00EE\u0219\u021B\u0102\u00C2\u00CE\u0218\u021A]/u, weight: 4 },
    { language: 'en', pattern: /\b(the|and|you|hello|please|wine|grape|winery|recommend|what|why|how)\b/i, weight: 2 },
    { language: 'ro', pattern: /\b(spune|vreau|buna|salut|struguri|romana|vorbeste)\b/i, weight: 3 },
    { language: 'fr', pattern: /[\u00E9\u00E8\u00EA\u00E0\u00E7\u00F4\u00FB\u00F9]/iu, weight: 4 },
    { language: 'fr', pattern: /\b(le|la|les|c\u00E9page|bonjour|merci|vigne|pourquoi|comment)\b/i, weight: 4 },
    { language: 'it', pattern: /\b(ciao|grazie|vitigno|buongiorno|perch\u00E9|come|quale)\b/i, weight: 4 },
    { language: 'es', pattern: /[\u00BF\u00A1\u00F1]/u, weight: 4 },
    { language: 'es', pattern: /\b(hola|gracias|uva|qu\u00E9|c\u00F3mo)\b/i, weight: 4 },
    { language: 'de', pattern: /[\u00E4\u00F6\u00FC\u00DF\u00C4\u00D6\u00DC]/u, weight: 4 },
    { language: 'de', pattern: /\b(und|ich|nicht|wein|traube|danke|warum|wie)\b/i, weight: 4 },
    { language: 'ja', pattern: /[\u3040-\u30FF]/u, weight: 7 },
    { language: 'zh', pattern: /[\u4E00-\u9FFF]/u, weight: 4 },
];
const MIN_LANGUAGE_SWITCH_SIGNIFICANT_WORDS = Number(process.env.LANGUAGE_SWITCH_MIN_WORDS || 3);
const LANGUAGE_SWITCH_CONFIRMATIONS = Number(process.env.LANGUAGE_SWITCH_CONFIRMATIONS || 2);
const LANGUAGE_NOISE_WORDS = new Set([
    'ok', 'okay', 'yes', 'yeah', 'no', 'not', 'the', 'and', 'you', 'please',
    'да', 'нет', 'ага', 'угу', 'ну', 'ой', 'эй', 'алло',
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

const DEFAULT_TIMEZONE = 'Europe/Chisinau';
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

function createGeneration({ turnId, mode, interactionId, providerInstanceId }) {
    return {
        turnId,
        mode: mode || null,
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
        noSpeechChecked: false,
        interactionId: interactionId || null,
        providerInstanceId: providerInstanceId || null,
        serverFramesReceived: 0,
        lastFrameBytes: 0,
        providerBytesSent: 0,
        summaryLogged: false,
    };
}

function attachRealtimeServer(server, options = {}) {
    const defaultProvider = new MockRealtimeProvider(options.mockConfig || DEFAULT_CONFIG);
    const providerFactory = options.providerFactory || ((sessionOptions = {}) => defaultProvider.createSession(sessionOptions));
    const providerMetadata = options.providerMetadata || { provider: 'mock', model: 'mock' };
    const resolveProvider = typeof options.resolveProvider === 'function' ? options.resolveProvider : null;
    const resolveAdultVerification = typeof options.isAdultVerified === 'function' ? options.isAdultVerified : () => false;

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
        createRealtimeSession(socket, connectionProviderFactory, connectionProviderMetadata, {
            isAdultVerified: resolveAdultVerification(req) === true,
        });
    });
}

function createRealtimeSession(socket, providerFactory, providerMetadata = {}, sessionAccess = {}) {
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
    let currentInteractionId = null;
    let sessionClientInstanceId = null;
    let sessionWebsocketConnectionId = null;
    let currentGeneration = null;
    let inputStartedAt = 0;
    let inputEndedAt = 0;
    let inputBytes = 0;
    let currentInputChunks = [];
    let currentInputBufferedBytes = 0;
    let turnLoudSampleCount = 0;
    let turnTotalSampleCount = 0;
    let sessionInputBytes = 0;
    let currentMode = personaStore.getVoiceMode() === 'tap_to_start' ? 'tap_to_start' : 'push_to_talk';
    let sessionVoiceMode = currentMode;
    let turnCounter = 0;
    let micPipelineConfirmed = false;
    let micPipelineTrackId = null;
    let clientTelemetryWindowStartedAt = 0;
    let clientTelemetryCountInWindow = 0;
    let clientTelemetryRateLimitWarned = false;
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
    let firstMeaningfulTurnSeen = false;
    let firstForeignWelcomeSent = false;
    let firstForeignWelcomeInstruction = null;
    const contentToolsEnabled = areContentToolsEnabled(providerMetadata.contentToolsEnabled);
    const toolDeclarations = Array.isArray(providerMetadata.toolDeclarations) ? providerMetadata.toolDeclarations : [];
    const sessionMemory = typeof providerMetadata.createSessionMemory === 'function'
        ? providerMetadata.createSessionMemory()
        : null;
    const toolContext = { sessionMemory, recentTurns, isAdultVerified: sessionAccess.isAdultVerified === true, log: (stage, extra) => log(stage, extra) };
    const toolHandlers = typeof providerMetadata.createToolHandlers === 'function'
        ? providerMetadata.createToolHandlers(toolContext)
        : (providerMetadata.toolHandlers && typeof providerMetadata.toolHandlers === 'object' ? providerMetadata.toolHandlers : {});
    let promptDebugRequested = false;
    let cachedLocalDateTime = null;
    let inputSampleRate = GEMINI_INPUT_SAMPLE_RATE;
    let inputSampleRateSource = 'assumed_default_no_sample_rate';
    let inputResampler = createInputResampler(inputSampleRate);
    let sessionRuntimeSnapshot = null;
    let providerSession = providerFactory(buildProviderSessionOptions('initial'));
    let providerSessionUsedForTurn = false;
    let lastTurnProviderInstanceId = null;
    let invariantViolationCount = 0;
    const clientPttSummaryByInteraction = new Map();
    const summaryLoggedInteractions = new Set();

    function log(stage, extra = {}) {
        const details = Object.entries(extra)
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        console.log(`[Realtime] session=${sessionId} stage=${stage} ${details}`.trim());
    }

    function emit(payload) {
        if (socketClosed || socket.destroyed) return false;
        if (payload.type === 'session.ready') readySent = true;
        return sendJson(socket, { session_id: sessionId, server_time_ms: Date.now(), ...payload });
    }

    const visualOrchestrator = createVisualOrchestrator({ emit, log });

    function rememberTurn(role, text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        recentTurns.push({ role, text: clean.slice(0, 240) });
        while (recentTurns.length > 12) recentTurns.shift();
    }

    function buildPromptBundle() {
        const personaText = sessionRuntimeSnapshot ? sessionRuntimeSnapshot.effectivePrompt : promptBlocks.persona;
        const languageInstruction = firstForeignWelcomeInstruction
            || (sessionLanguage
                ? `Continue in the last clearly understood language: ${sessionLanguage}. Keep the same voice identity.`
                : 'No stable language has been established yet. Follow the last clearly understood utterance.');
        return buildRealtimeSystemInstruction({
            persona: personaText,
            currentContext: {
                mode: currentMode,
                sessionLanguage: sessionLanguage || 'auto',
                languageInstruction,
                recentTurns,
                localDateTime: cachedLocalDateTime,
                sessionMemory: sessionMemory ? sessionMemory.formatForPrompt() : null,
            },
        });
    }

    function buildProviderVoiceOptions(providerId, voiceId) {
        return { voiceName: voiceId };
    }

    function buildProviderSessionOptions(rotationReason) {
        const prompt = buildPromptBundle();
        const voiceId = sessionRuntimeSnapshot ? sessionRuntimeSnapshot.resolvedVoiceId : sessionVoiceName;
        const voiceSource = sessionRuntimeSnapshot ? sessionRuntimeSnapshot.voiceSource : sessionVoiceConfigSource;
        const providerId = providerMetadata.provider;
        const voiceOpts = buildProviderVoiceOptions(providerId, voiceId);
        return {
            ...voiceOpts,
            voiceConfigSource: voiceSource,
            systemInstructionText: prompt.text,
            systemInstructionMeta: prompt.meta,
            promptSource,
            rotationReason,
            rotationMode,
            contentToolsEnabled,
            toolDeclarations: contentToolsEnabled ? toolDeclarations : [],
            toolHandlers: contentToolsEnabled ? toolHandlers : {},
            voiceMode: personaStore.getVoiceMode(),
            onProviderEvent: emit,
            onUserSpeechStarted: handleNativeSpeechStarted,
            onUserSpeechStopped: handleNativeSpeechStopped,
        };
    }

    function isTurnOpen() {
        return Boolean(currentGeneration && currentGeneration.status === 'pending' && inputStartedAt && !inputEndedAt);
    }

    function handleNativeSpeechStarted() {
        if (sessionVoiceMode !== 'tap_to_start') return;
        if (isTurnOpen()) {
            log('native_speech_signal', {
                decision: 'ignored_duplicate_user_input',
                provider: providerSession?.name || 'provider',
                turnId: currentTurnId,
                generationId: currentGeneration?.generationId || null,
            });
            return;
        }
        const hadActiveResponse = Boolean(currentGeneration && currentGeneration.status === 'active');
        const cancelledActiveGeneration = cancelCurrent('native_speech_started');
        if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) rotateProviderSession('native_speech_started');
        if (!micPipelineConfirmed) {
            log('native_speech_started_ignored_unconfirmed_mic', {
                decision: 'ignored_unconfirmed_mic',
                provider: providerSession?.name || 'provider',
                micPipelineTrackId,
            });
            return;
        }
        log('native_speech_started', {
            decision: 'accepted', provider: providerSession?.name || 'provider', micPipelineTrackId, hadActiveResponse,
        });
        startInput({ mode: 'tap_to_start' });
    }

    function handleNativeSpeechStopped(generationId) {
        if (sessionVoiceMode !== 'tap_to_start') return;
        if (generationId && (!currentGeneration || currentGeneration.generationId !== generationId)) {
            log('native_speech_stopped_ignored_stale_generation', {
                provider: providerSession?.name || 'provider', generationId,
                currentGenerationId: currentGeneration?.generationId || 'none',
            });
            return;
        }
        if (!isTurnOpen()) return;
        log('native_speech_stopped', { provider: providerSession?.name || 'provider' });
        endInput({ end_reason: 'provider_vad' });
    }

    function safePromptPayload() {
        const prompt = buildPromptBundle();
        return {
            allow_custom_prompt: DASHBOARD_ALLOW_CUSTOM_PROMPT,
            max_chars: PROMPT_MAX_CHARS,
            source: promptSource,
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
            input_audio: {
                sample_rate: inputSampleRate,
                sample_rate_source: inputSampleRateSource,
                gemini_input_sample_rate: GEMINI_INPUT_SAMPLE_RATE,
            },
            access: { adult_verified: toolContext.isAdultVerified },
            prompt_debug: {
                allow_custom_prompt: DASHBOARD_ALLOW_CUSTOM_PROMPT,
                max_chars: PROMPT_MAX_CHARS,
                current_context: prompt.blocks.currentContext,
                meta: prompt.meta,
                ...(promptDebugRequested ? { applied_blocks: { persona: prompt.blocks.persona } } : {}),
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
            from: previousLanguage, to: nextLanguage, detectedAt: Date.now(),
            generationId: generation?.generationId || null, turnId: generation?.turnId || null,
        };
        pendingLanguageCandidate = null;
        log('language_switch_detected', {
            generationId: generation?.generationId || 'none', turnId: generation?.turnId || 'none',
            from: previousLanguage, to: nextLanguage, significantWordCount: signal.significantWordCount,
            confirmationCount, reason, action: 'rotate_before_next_turn',
        });
        emit({
            type: 'language.switch_detected', from_language: previousLanguage, to_language: nextLanguage,
            generation_id: generation?.generationId || null, turn_id: generation?.turnId || null,
            significant_word_count: signal.significantWordCount, confirmation_count: confirmationCount,
            reason, action: 'rotate_before_next_turn',
        });
    }

    function applyFirstForeignWelcomePolicy(detectedLanguage, generation) {
        const next = deriveFirstForeignWelcomeState({
            currentLanguage: sessionLanguage,
            detectedLanguage,
            alreadySent: firstForeignWelcomeSent,
            firstMeaningfulTurnSeen,
        });
        firstMeaningfulTurnSeen = next.firstMeaningfulTurnSeen;
        firstForeignWelcomeSent = next.alreadySent;
        if (!next.welcomePending || !next.instruction) return;
        firstForeignWelcomeInstruction = next.instruction;
        log('first_foreign_welcome_scheduled', {
            generationId: generation?.generationId || 'none',
            turnId: generation?.turnId || 'none',
            language: detectedLanguage,
        });
        // The provider's system prompt was created before the first transcript
        // existed. Rotate now, before model output, so this exact generation
        // sees the one-shot greeting instruction in its system context.
        rotateProviderSession('first_foreign_welcome');
        if (generation && generation === currentGeneration) {
            generation.providerInstanceId = providerSession?.instanceId || generation.providerInstanceId;
        }
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
                        generationId: generation?.generationId || 'none', turnId: generation?.turnId || 'none',
                        language: detectedLanguage, significantWordCount: signal.significantWordCount,
                        confirmationCount: pendingLanguageCandidate.count, action: 'wait_for_confirmation',
                    });
                    return;
                }
            }
            sessionLanguage = detectedLanguage;
            pendingLanguageCandidate = null;
            applyFirstForeignWelcomePolicy(detectedLanguage, generation);
            log('language_detected', {
                generationId: generation?.generationId || 'none', turnId: generation?.turnId || 'none',
                language: detectedLanguage, significantWordCount: signal.significantWordCount,
                confirmationCount: signal.confident ? 1 : LANGUAGE_SWITCH_CONFIRMATIONS,
                action: signal.confident ? 'set_initial' : 'set_initial_confirmed',
            });
            return;
        }
        if (!firstMeaningfulTurnSeen) applyFirstForeignWelcomePolicy(detectedLanguage, generation);
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
            generationId: generation?.generationId || 'none', turnId: generation?.turnId || 'none',
            from: previousLanguage, to: detectedLanguage, significantWordCount: signal.significantWordCount,
            confirmationCount: pendingLanguageCandidate.count, action: 'wait_for_confirmation',
        });
        if (pendingLanguageCandidate.count >= LANGUAGE_SWITCH_CONFIRMATIONS) {
            scheduleLanguageSwitch(previousLanguage, detectedLanguage, generation, signal, 'consecutive_confirmation', pendingLanguageCandidate.count);
        }
    }

    function applyPendingLanguageSwitchBeforeInput() {
        if (!pendingLanguageSwitch) return;
        const languageSwitch = pendingLanguageSwitch;
        pendingLanguageSwitch = null;
        log('language_switch_rotation_started', {
            from: languageSwitch.from, to: languageSwitch.to,
            previousGenerationId: languageSwitch.generationId || 'none', previousTurnId: languageSwitch.turnId || 'none',
            providerInstanceId: providerSession?.instanceId || 'unknown',
        });
        rotateProviderSession('language_switch');
        warmProviderSession('language_switch').catch((error) => {
            log('provider_warm_error', { reason: 'language_switch', message: error.message });
        });
    }

    function droppedProviderEvent(generation, eventType, reason) {
        lateProviderEventsDropped += 1;
        log('dropped_provider_event', {
            generationId: generation?.generationId || 'none', responseId: generation?.responseId || 'none',
            eventType, reason, lateProviderEventsDropped,
        });
    }

    function clearGenerationTimeout(generation) {
        if (!generation?.timeoutTimer) return;
        clearTimeout(generation.timeoutTimer);
        generation.timeoutTimer = null;
    }

    function clearInputHangTimeout(generation) {
        if (!generation?.inputHangTimer) return;
        clearTimeout(generation.inputHangTimer);
        generation.inputHangTimer = null;
    }

    function armInputHangTimeout(generation) {
        if (!generation || sessionVoiceMode !== 'tap_to_start') return;
        clearInputHangTimeout(generation);
        const timeoutMs = Math.max(0, Number(process.env.TAP_INPUT_HANG_TIMEOUT_MS || 12000));
        if (timeoutMs <= 0) return;
        generation.inputHangTimer = setTimeout(() => {
            if (
                generation === currentGeneration
                && generation.status === 'pending'
                && inputStartedAt
                && !inputEndedAt
                && !generation.cancel.cancelled
            ) {
                log('input_hang_timeout', {
                    generationId: generation.generationId, turnId: generation.turnId,
                    timeoutMs, turnInputBytes: inputBytes, sessionInputBytes,
                });
                const cancelledActiveGeneration = cancelCurrent('input_hang_timeout');
                if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) rotateProviderSession('input_hang_timeout');
            }
        }, timeoutMs);
    }

    function armPttTurnTimeout(generation) {
        if (!generation || (currentMode !== 'push_to_talk' && currentMode !== 'tap_to_start')) return;
        clearGenerationTimeout(generation);
        const timeoutMs = Math.max(0, Number(process.env.PTT_TURN_TIMEOUT_MS || 4500));
        if (timeoutMs <= 0) return;
        generation.timeoutTimer = setTimeout(() => {
            if (generation.status === 'pending' && !generation.responseCreatedSent && !generation.cancel.cancelled) {
                recoverFromTurnTimeout(generation, timeoutMs).catch((error) => {
                    log('turn_timeout_recovery_error', {
                        generationId: generation.generationId, turnId: generation.turnId, message: error.message,
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
            reason, provider: providerSession.name || 'provider',
            providerInstanceId: providerSession.instanceId || 'unknown',
            voiceName: providerSession.voiceName || sessionVoiceName || 'none',
            rotationMode, promptApplyCount,
        });
        emit({ type: 'provider.ready', reason, provider: providerSession.name || 'provider', provider_instance_id: providerSession.instanceId || null });
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
        emit({
            type: 'response.failed', generation_id: generation.generationId, response_id: generation.responseId,
            turn_id: generation.turnId, reason: 'provider_timeout', timeout_ms: timeoutMs,
        });
        rotateProviderSession('provider_timeout');
        await warmProviderSession('provider_timeout');
        logPttSummary(generation, 'provider_timeout');
    }

    async function recoverFromProviderFailure(generation, reason, payload = {}) {
        if (generation !== currentGeneration) {
            droppedProviderEvent(generation, 'response.failed', 'stale_generation');
            return;
        }
        if (currentMode !== 'text' && await retryGenerationOnFreshProvider(generation, reason)) return;
        generation.status = 'failed';
        generation.cancel.cancel(reason);
        clearGenerationTimeout(generation);
        logPttSummary(generation, reason);
        emit({ ...payload, type: 'response.failed', generation_id: generation.generationId, response_id: generation.responseId, turn_id: generation.turnId, reason });
        rotateProviderSession(reason);
        await warmProviderSession(reason);
    }

    async function retryGenerationOnFreshProvider(generation, reason) {
        const retryableReasons = new Set(['provider_turn_closed_before_output', 'provider_turn_closed_during_input']);
        if (!retryableReasons.has(reason)) return false;
        if (generation.providerRetryAttempted || !generation.inputEndedAt || generation.responseCreatedSent) return false;
        if (currentInputChunks.length === 0 || currentInputBufferedBytes <= 0) return false;
        if (generation.cancel.cancelled || generation.status === 'cancelled' || generation.status === 'completed') return false;
        generation.providerRetryAttempted = true;
        clearGenerationTimeout(generation);
        rotateProviderSession(reason);
        generation.cancel = createCancellation();
        generation.status = 'pending';
        const retryContext = buildProviderContext(generation);
        if (typeof providerSession.beginResponse === 'function') providerSession.beginResponse(retryContext);
        for (const chunk of currentInputChunks) {
            if (generation !== currentGeneration || generation.cancel.cancelled) return true;
            providerSession.sendAudio(chunk);
        }
        armPttTurnTimeout(generation);
        providerSession.endInput(retryContext).catch((error) => {
            recoverFromProviderFailure(generation, 'provider_retry_error', {
                type: 'response.failed', reason: 'provider_retry_error', message: error.message,
            }).catch(() => {});
        });
        return true;
    }

    function emitResponseCreated(generation, cause) {
        if (!generation || generation.responseCreatedSent) return;
        if (generation.status === 'cancelled' || generation.status === 'completed') return;
        generation.responseId = generation.responseId || id('response');
        clearGenerationTimeout(generation);
        generation.responseCreatedSent = true;
        generation.status = 'active';
        emit({
            type: 'response.created', generation_id: generation.generationId, response_id: generation.responseId,
            turn_id: generation.turnId, cause, turn_input_bytes: inputBytes, session_input_bytes: sessionInputBytes,
        });
    }

    function emitProviderEvent(generation, payload) {
        if (!generation) return false;
        const eventType = payload?.type || 'unknown';
        const modelOutputEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk', 'audio.end']);
        const startsGenerationEvents = new Set(['transcript.model', 'audio.start', 'audio.chunk']);
        if (eventType === 'provider_interrupt_ack') return emit(payload);
        if (eventType === 'provider.dropped_event') {
            droppedProviderEvent(generation, payload.event_type || 'unknown', payload.reason || 'provider_dropped_event');
            return true;
        }
        if (eventType === 'response.failed') {
            visualOrchestrator.cancel(generation.generationId, payload.reason || 'provider_failed');
            recoverFromProviderFailure(generation, payload.reason || 'provider_failed', payload).catch(() => {});
            return true;
        }
        if (generation.status === 'cancelled' || generation.status === 'completed' || generation.status === 'failed') {
            if (modelOutputEvents.has(eventType)) droppedProviderEvent(generation, eventType, 'terminal_generation');
            return false;
        }
        if (eventType === 'transcript.user') {
            generation.userTranscriptBuffer += String(payload.text || '');
            visualOrchestrator.noteUserText(generation.generationId, payload.text);
        }
        if (eventType === 'transcript.user' && generation.inputEndedAt && !generation.firstInputTranscriptionAt) {
            rememberTurn('user', payload.text);
            noteUserLanguage(payload.text, generation);
            generation.firstInputTranscriptionAt = Date.now();
            log('provider_input_transcription_received', {
                generationId: generation.generationId, turnId: generation.turnId,
                inputEndToInputTranscriptionMs: generation.firstInputTranscriptionAt - generation.inputEndedAt,
            });
            if (firstForeignWelcomeInstruction) {
                // Re-dispatch the completed input on the freshly-rotated provider
                // so the same first turn gets the greeting, not the next turn.
                const context = buildProviderContext(generation);
                if (typeof providerSession.beginResponse === 'function') providerSession.beginResponse(context);
                for (const chunk of currentInputChunks) providerSession.sendAudio(chunk);
                providerSession.endInput(context).catch((error) => {
                    recoverFromProviderFailure(generation, 'first_foreign_welcome_replay_error', {
                        type: 'response.failed', reason: 'first_foreign_welcome_replay_error', message: error.message,
                    }).catch(() => {});
                });
                firstForeignWelcomeInstruction = null;
                return true;
            }
        }
        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.noSpeechChecked) {
            generation.noSpeechChecked = true;
            if (generation.mode === 'push_to_talk' && !generation.userTranscriptBuffer.trim()) {
                emit({ type: 'input_audio.no_speech', turn_id: generation.turnId, generation_id: generation.generationId });
                cancelCurrent('no_speech');
                return false;
            }
        }
        if (startsGenerationEvents.has(eventType) && generation.inputEndedAt && !generation.firstModelEventAt) {
            generation.firstModelEventAt = Date.now();
        }
        if (eventType === 'audio.start' && generation.inputEndedAt && !generation.firstValidAudioAt) generation.firstValidAudioAt = Date.now();
        if (eventType === 'transcript.model') assistantTranscriptBuffer += String(payload.text || '');
        if (startsGenerationEvents.has(eventType)) emitResponseCreated(generation, eventType);
        if (eventType === 'response.cancelled') {
            generation.status = 'cancelled';
            clearGenerationTimeout(generation);
            assistantTranscriptBuffer = '';
        }
        const shouldRotateAfterAudioEnd = eventType === 'audio.end' && shouldRotateProviderAfterOutputComplete();
        if (eventType === 'audio.end') {
            generation.status = 'completed';
            clearGenerationTimeout(generation);
            if (assistantTranscriptBuffer.trim()) rememberTurn('assistant', assistantTranscriptBuffer);
            assistantTranscriptBuffer = '';
            if (shouldRotateAfterAudioEnd) rotateProviderSession('output_complete');
        }
        return emit(payload);
    }

    function isTerminalGeneration(generation) {
        return !generation || ['cancelled', 'completed', 'failed'].includes(generation.status);
    }

    function logPttSummary(generation, status, clientSummaryOverride = null) {
        const interactionId = generation?.interactionId || clientSummaryOverride?.interactionId || null;
        if (!interactionId || summaryLoggedInteractions.has(interactionId)) return;
        summaryLoggedInteractions.add(interactionId);
        clientPttSummaryByInteraction.delete(interactionId);
        log('ptt_summary', {
            interactionId,
            turnId: generation?.turnId || clientSummaryOverride?.turnId || 'none',
            generationId: generation?.generationId || 'none',
            status,
        });
    }

    function cancelCurrent(reason) {
        if (!currentGeneration || isTerminalGeneration(currentGeneration)) return false;
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
        if (sessionVoiceMode === 'tap_to_start' && !inputEndedAt) inputEndedAt = Date.now();
        clearGenerationTimeout(currentGeneration);
        clearInputHangTimeout(currentGeneration);
        visualOrchestrator.cancel(currentGeneration.generationId, reason);
        emit({
            type: 'response.cancelled', generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId, turn_id: currentGeneration.turnId,
            reason, cancel_latency_ms: Date.now() - cancelRequestedAt,
        });
        logPttSummary(currentGeneration, reason);
        return true;
    }

    function rotateProviderSession(reason) {
        providerRotationCount += 1;
        providerSessionUsedForTurn = false;
        const oldProviderSession = providerSession;
        try {
            if (typeof oldProviderSession.destroySession === 'function') oldProviderSession.destroySession(reason);
            else oldProviderSession.close();
        } catch {}
        providerSession = providerFactory(buildProviderSessionOptions(reason));
        emit({
            type: 'provider.rotated', reason,
            old_provider_instance_id: oldProviderSession?.instanceId || null,
            new_provider_instance_id: providerSession.instanceId || null,
            provider: providerSession.name || 'provider',
        });
    }

    function countLoudSamples(buffer) {
        const threshold = noSpeechAmplitudeThreshold();
        const sampleCount = buffer.length >> 1;
        turnTotalSampleCount += sampleCount;
        for (let i = 0; i < sampleCount; i += 1) {
            const sample = buffer.readInt16LE(i * 2);
            if (sample >= threshold || sample <= -threshold) turnLoudSampleCount += 1;
        }
    }

    function bufferHasLoudSample(buffer) {
        const threshold = noSpeechAmplitudeThreshold();
        const sampleCount = buffer.length >> 1;
        for (let i = 0; i < sampleCount; i += 1) {
            const sample = buffer.readInt16LE(i * 2);
            if (sample >= threshold || sample <= -threshold) return true;
        }
        return false;
    }

    function shouldRotateProviderOnInterrupt() { return Boolean(providerSession?.rotateOnInterrupt); }
    function shouldRotateProviderAfterOutputComplete() { return rotationMode === 'per_turn' && Boolean(providerSession?.rotateAfterOutputComplete); }

    function closeProvider(reason) {
        if (providerClosed) return;
        providerClosed = true;
        inputResampler.reset();
        cancelCurrent(reason);
        providerSession.close();
        log('provider_session_closed', { reason, provider: providerSession.name || 'provider', providerInstanceId: providerSession.instanceId || 'unknown' });
    }

    function startInput(payload = {}) {
        applyPendingLanguageSwitchBeforeInput();
        assistantTranscriptBuffer = '';
        const cancelledActiveGeneration = cancelCurrent('new_input');
        if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) rotateProviderSession('new_input_after_cancel');
        if (rotationMode === 'per_turn' && providerSession?.rotateOnInterrupt && providerSessionUsedForTurn) rotateProviderSession('per_turn_new_turn');
        turnCounter += 1;
        currentTurnId = payload.turn_id || id(`turn${turnCounter}`);
        currentInteractionId = payload.interaction_id || null;
        turnLoudSampleCount = 0;
        turnTotalSampleCount = 0;
        currentMode = payload.mode || 'push_to_talk';
        if (currentMode === 'tap_to_start' || currentMode === 'push_to_talk') sessionVoiceMode = currentMode;
        currentGeneration = createGeneration({
            turnId: currentTurnId, mode: currentMode, interactionId: currentInteractionId,
            providerInstanceId: providerSession?.instanceId || null,
        });
        if (
            rotationMode === 'per_turn' && providerSession?.rotateOnInterrupt && lastTurnProviderInstanceId
            && currentGeneration.providerInstanceId && currentGeneration.providerInstanceId === lastTurnProviderInstanceId
        ) invariantViolationCount += 1;
        providerSessionUsedForTurn = true;
        lastTurnProviderInstanceId = currentGeneration.providerInstanceId;
        visualOrchestrator.beginGeneration({ generationId: currentGeneration.generationId, turnId: currentTurnId });
        if (currentMode === 'tap_to_start' && typeof payload.micEchoCancellation === 'boolean') {
            micPipelineConfirmed = payload.micEchoCancellation === true;
            micPipelineTrackId = payload.micTrackId || null;
        }
        inputStartedAt = Date.now();
        inputEndedAt = 0;
        inputBytes = 0;
        currentInputChunks = [];
        currentInputBufferedBytes = 0;
        inputResampler.reset();
        emit({ type: 'input_audio.start', turn_id: currentTurnId, generation_id: currentGeneration.generationId, response_id: null, mode: currentMode });
        const generationForStream = currentGeneration;
        if (typeof providerSession.beginResponse === 'function') providerSession.beginResponse(buildProviderContext(generationForStream));
        armInputHangTimeout(currentGeneration);
    }

    function endInput(payload = {}) {
        if (!currentTurnId || !inputStartedAt) {
            emit({ type: 'error', code: 'input_not_started', message: 'input_audio.end received before input_audio.start' });
            return;
        }
        if (inputEndedAt) return;
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
            }
        } finally {
            inputResampler.reset();
        }
        inputEndedAt = Date.now();
        const recordingDurationMs = inputEndedAt - inputStartedAt;
        if (!currentGeneration) currentGeneration = createGeneration({ turnId: currentTurnId, mode: currentMode });
        clearInputHangTimeout(currentGeneration);
        emit({
            type: 'input_audio.end', turn_id: currentTurnId, generation_id: currentGeneration.generationId,
            response_id: currentGeneration.responseId, duration_ms: recordingDurationMs,
            turn_input_bytes: inputBytes, session_input_bytes: sessionInputBytes,
            end_reason: payload.end_reason || null, mode: currentMode,
        });
        visualOrchestrator.markThinking(currentGeneration.generationId);
        const generationForStream = currentGeneration;
        generationForStream.inputEndedAt = inputEndedAt;
        if (currentMode === 'push_to_talk') {
            const minLoudMs = noSpeechMinLoudMs();
            const turnLoudMs = (turnLoudSampleCount / NO_SPEECH_SAMPLE_RATE) * 1000;
            if (turnLoudMs < minLoudMs) {
                log('no_speech_candidate', { turnId: currentTurnId, generationId: generationForStream.generationId, turnLoudMs: Math.round(turnLoudMs), thresholdMs: minLoudMs });
            }
        }
        armPttTurnTimeout(generationForStream);
        providerSession.endInput(buildProviderContext(generationForStream)).catch((error) => {
            emit({ type: 'error', generation_id: generationForStream.generationId, code: 'provider_error', provider: providerSession.name || 'provider', message: error.message });
        });
    }

    function submitTextInput(payload = {}) {
        const text = String(payload.text || '').trim();
        if (!text) { emit({ type: 'error', code: 'input_text_empty', message: 'Text input must not be empty.' }); return; }
        if (text.length > 1200) { emit({ type: 'error', code: 'input_text_too_long', message: 'Text input must be 1200 characters or fewer.' }); return; }
        if (typeof providerSession.sendText !== 'function') { emit({ type: 'error', code: 'text_input_unsupported', message: 'The active provider does not support text input.' }); return; }
        startInput({ turn_id: payload.turn_id, mode: 'text' });
        inputEndedAt = Date.now();
        const generationForText = currentGeneration;
        generationForText.inputEndedAt = inputEndedAt;
        emit({ type: 'input_text.submitted', turn_id: currentTurnId, generation_id: generationForText.generationId, text, chars: text.length });
        emitProviderEvent(generationForText, { type: 'transcript.user', response_id: generationForText.responseId, turn_id: currentTurnId, text });
        visualOrchestrator.markThinking(generationForText.generationId);
        armPttTurnTimeout(generationForText);
        const textContext = buildProviderContext(generationForText);
        if (firstForeignWelcomeInstruction) {
            const instruction = firstForeignWelcomeInstruction;
            firstForeignWelcomeInstruction = null;
            rotateProviderSession('first_foreign_welcome_text');
            const replayContext = buildProviderContext(generationForText);
            providerSession.sendText(text, replayContext).catch((error) => {
                emit({ type: 'error', generation_id: generationForText.generationId, code: 'provider_error', provider: providerSession.name || 'provider', message: error.message });
            });
            return;
        }
        providerSession.sendText(text, textContext).catch((error) => {
            emit({ type: 'error', generation_id: generationForText.generationId, code: 'provider_error', provider: providerSession.name || 'provider', message: error.message });
        });
    }

    function handleCommand(raw) {
        let payload;
        try { payload = JSON.parse(raw); }
        catch { emit({ type: 'error', code: 'invalid_json', message: 'Invalid JSON command' }); return; }

        if (payload.type === 'session.start') {
            if (currentGeneration && !['completed', 'cancelled', 'failed'].includes(currentGeneration.status)) {
                emit({ type: 'error', code: 'session_config_busy', message: 'Prompt config can be changed only while the realtime session is idle.' });
                return;
            }
            if (payload.client_instance_id) sessionClientInstanceId = String(payload.client_instance_id).slice(0, 64);
            if (payload.websocket_connection_id) sessionWebsocketConnectionId = String(payload.websocket_connection_id).slice(0, 64);
            try {
                const resolved = resolveInputSampleRate(payload);
                inputSampleRate = resolved.rate;
                inputSampleRateSource = resolved.source;
                inputResampler = createInputResampler(inputSampleRate);
            } catch (error) {
                emit({ type: 'error', code: error.code || 'unsupported_input_sample_rate', message: `Unsupported sampleRate ${error.requestedRate} in session.start. Supported values: 16000, 24000.` });
                return;
            }
            promptDebugRequested = payload.include_prompt_debug === true;
            if (typeof payload.language === 'string' && /^[a-z]{2}$/i.test(payload.language)) {
                sessionLanguage = payload.language.toLowerCase();
            }
            (async () => {
                try {
                    const sanitized = sanitizePromptConfig(payload.config || {}, { allowCustomPrompt: DASHBOARD_ALLOW_CUSTOM_PROMPT });
                    promptBlocks = sanitized.blocks;
                    promptSource = sanitized.source;
                    cachedLocalDateTime = formatLocalDateTime(DEFAULT_TIMEZONE, new Date());
                    const cachedPersona = personaStore.getCached();
                    const resolvedProfile = resolveProfile(cachedPersona.baseProfileId, cachedPersona.overrides, cachedPersona.mood);
                    const effectivePrompt = buildProfileRuntimePrompt({
                        corePrompt: resolvedProfile.system_prompt || CORE_PERSONA_PROMPT,
                        personalityPrompt: resolvedProfile.personalityPrompt,
                        style: resolvedProfile.style,
                        mood: resolvedProfile.mood,
                        sommelierGender: resolvedProfile.sommelierGender,
                        name: resolvedProfile.name,
                        description: resolvedProfile.description,
                        welcomeMessage: resolvedProfile.welcome_message,
                    });
                    const providerId = providerMetadata.provider;
                    const providerDefaultVoiceId = providerMetadata.defaultVoiceName || undefined;
                    let resolved = resolveProfileRuntime({
                        providerId,
                        profileRuntimeDefaults: resolvedProfile.runtimeByProvider || {},
                        runtimeOverrides: cachedPersona.overrides.runtimeByProvider || {},
                        legacyClientVoiceId: payload.voiceName || null,
                        allowLegacyVoice: env.REALTIME_ALLOW_LEGACY_VOICE_OVERRIDE,
                        providerDefaultVoiceId,
                    });
                    sessionRuntimeSnapshot = {
                        providerId,
                        baseProfileId: cachedPersona.baseProfileId,
                        resolvedVoiceId: resolved.resolvedVoiceId,
                        voiceSource: resolved.source,
                        sommelierGender: resolvedProfile.sommelierGender,
                        mood: resolvedProfile.mood,
                        effectivePrompt,
                    };
                    sessionVoiceName = sessionRuntimeSnapshot.resolvedVoiceId;
                    sessionVoiceConfigSource = sessionRuntimeSnapshot.voiceSource;
                    rotateProviderSession('session_start_config');
                    emitPromptApplied('session.start');
                } catch (error) {
                    emit({ type: 'error', code: 'prompt_config_invalid', message: error.code || error.message });
                    return;
                }
                try { await warmProviderSession('session_start_config'); }
                catch (error) { emit({ type: 'provider.connect_failed', reason: 'session_start_config', message: error.message || String(error) }); }
            })();
        } else if (payload.type === 'input_audio.start') startInput(payload);
        else if (payload.type === 'input_audio.end') endInput(payload);
        else if (payload.type === 'input_audio.speech_start') {
            if (sessionVoiceMode === 'tap_to_start') handleNativeSpeechStarted();
        }
        else if (payload.type === 'input_text.submit') submitTextInput(payload);
        else if (payload.type === 'session.interrupt') {
            inputResampler.reset();
            const cancelledActiveGeneration = cancelCurrent(payload.reason || 'client_interrupt');
            if (cancelledActiveGeneration && shouldRotateProviderOnInterrupt()) rotateProviderSession(payload.reason || 'client_interrupt');
        }
        else if (payload.type === 'client_telemetry') {
            const now = Date.now();
            if (now - clientTelemetryWindowStartedAt > CLIENT_TELEMETRY_RATE_LIMIT_WINDOW_MS) {
                clientTelemetryWindowStartedAt = now;
                clientTelemetryCountInWindow = 0;
                clientTelemetryRateLimitWarned = false;
            }
            clientTelemetryCountInWindow += 1;
            if (clientTelemetryCountInWindow > CLIENT_TELEMETRY_RATE_LIMIT_MAX_PER_WINDOW) return;
            const stage = typeof payload.stage === 'string' ? payload.stage : '';
            if (!CLIENT_TELEMETRY_ALLOWED_STAGES.has(stage)) return;
            const sanitized = sanitizeClientTelemetryData(payload.data);
            if (stage === 'ptt_client_summary') {
                const interactionId = typeof sanitized.interactionId === 'string' ? sanitized.interactionId : null;
                if (!interactionId) return;
                const liveGeneration = currentGeneration && currentGeneration.interactionId === interactionId && !isTerminalGeneration(currentGeneration);
                if (liveGeneration) { clientPttSummaryByInteraction.set(interactionId, sanitized); return; }
                logPttSummary(null, 'client_no_turn', sanitized);
                return;
            }
            log('client_telemetry', { stage, ...sanitized });
        }
        else if (payload.type === 'ping') emit({ type: 'pong', timestamp_ms: payload.timestamp_ms || Date.now() });
        else emit({ type: 'error', code: 'unknown_command', message: `Unknown command type: ${payload.type || 'missing'}` });
    }

    const parser = createFrameParser({
        onText: handleCommand,
        onBinary(payload) {
            const isActiveTurn = Boolean(currentGeneration && inputStartedAt && !inputEndedAt);
            const continuousTapListening = sessionVoiceMode === 'tap_to_start' && turnCounter > 0;
            if (!isActiveTurn && !continuousTapListening) return;
            let outgoing = payload;
            try { outgoing = inputResampler.process(payload); }
            catch { inputResampler.reset(); return; }
            if (outgoing.length === 0) return;
            if (isActiveTurn) {
                inputBytes += outgoing.length;
                sessionInputBytes += outgoing.length;
                currentGeneration.serverFramesReceived += 1;
                currentGeneration.lastFrameBytes = outgoing.length;
                countLoudSamples(outgoing);
                if (currentInputBufferedBytes + outgoing.length <= MAX_TURN_REPLAY_BYTES) {
                    currentInputChunks.push(outgoing);
                    currentInputBufferedBytes += outgoing.length;
                }
                if (sessionVoiceMode === 'tap_to_start' && bufferHasLoudSample(outgoing)) armInputHangTimeout(currentGeneration);
            }
            providerSession.sendAudio(outgoing);
            if (currentGeneration) currentGeneration.providerBytesSent += outgoing.length;
        },
        onPing: sendPong,
        onClose(code, reason) {
            socketClosed = true;
            closeProvider('client_close');
            sendClose(socket, code, reason);
        },
        onError(error) {
            emit({ type: 'error', code: 'ws_protocol_error', message: error.message });
            socketClosed = true;
            closeProvider('protocol_error');
            socket.destroy();
        },
    });

    parser.start(socket);
    emit({
        type: 'session.ready',
        protocol_version: '1',
        session_id: sessionId,
        connected_at: connectedAt,
        provider: providerMetadata,
        prompt: safePromptPayload(),
    });
}

module.exports = {
    attachRealtimeServer,
    createRealtimeSession,
    detectLikelyLanguage,
    detectLanguageSignal,
    formatLocalDateTime,
    sanitizeClientTelemetryData,
};

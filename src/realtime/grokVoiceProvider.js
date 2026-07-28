'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');
const { normalizeGrokVoiceId, DEFAULT_GROK_VOICE_ID } = require('../grokVoices');

const DEFAULT_GROK_MODEL = process.env.GROK_VOICE_MODEL || process.env.XAI_VOICE_MODEL || 'grok-voice-latest';
const DEFAULT_GROK_REALTIME_URL = process.env.GROK_REALTIME_URL || process.env.XAI_REALTIME_URL || 'wss://api.x.ai/v1/realtime';
const MAX_PENDING_AUDIO_BYTES = Math.max(64 * 1024, Number(process.env.GROK_PENDING_AUDIO_MAX_BYTES || 512 * 1024));

function safeErrorMessage(error) {
    return String(error?.message || error || 'Grok Voice error')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"',\s]+/gi, 'apiKey=[redacted]')
        .slice(0, 300);
}

function makeInstanceId() {
    return `grok_session_${crypto.randomBytes(6).toString('hex')}`;
}

// Grok's response.cancel is fire-and-forget from our side (interrupt() sends
// it without waiting for a matching response.created) — whenever our own
// cancel races a response that already finished naturally on Grok's side,
// Grok replies with this exact error. It carries no consequence: nothing was
// left running, there is nothing to recover. Matched narrowly on both the
// error code and the exact known message text so a real invalid_request_error
// (bad payload, malformed turn, etc.) still fails the generation as before.
function isBenignCancellationRace(errorEvent) {
    const code = errorEvent?.error?.code || errorEvent?.code;
    const message = String(errorEvent?.error?.message || errorEvent?.message || '');
    return code === 'invalid_request_error' && message.includes('Cancellation failed: no active response found');
}

function normalizeJsonSchema(value) {
    if (Array.isArray(value)) return value.map(normalizeJsonSchema);
    if (!value || typeof value !== 'object') return value;
    const normalized = {};
    for (const [key, child] of Object.entries(value)) {
        normalized[key] = key === 'type' && typeof child === 'string'
            ? child.toLowerCase()
            : normalizeJsonSchema(child);
    }
    return normalized;
}

function buildGrokTools(declarations = []) {
    if (!Array.isArray(declarations)) return [];
    return declarations
        .map((declaration) => {
            const name = String(declaration?.name || '').trim();
            if (!name) return null;
            return {
                type: 'function',
                name,
                description: String(declaration.description || ''),
                parameters: normalizeJsonSchema(
                    declaration.parameters || { type: 'object', properties: {} },
                ),
            };
        })
        .filter(Boolean);
}

// turn_detection shape/behavior verified against xAI's own docs
// (docs.x.ai/developers/model-capabilities/audio/voice-agent and
// .../rest-api-reference/inference/voice) as of this change — NOT guessed:
// - server_vad config fields: type, threshold, prefix_padding_ms,
//   silence_duration_ms (documented range 0-10000), idle_timeout_ms.
//   Explicit values are set below rather than left to factory defaults —
//   two separate doc fetches reported inconsistent default `threshold`
//   values (0.5 vs 0.85), so an explicit number here is deliberate, not
//   copied from an uncertain default.
// - With server_vad active, `input_audio_buffer.commit` is documented as
//   FORBIDDEN (the server owns turn boundaries) — see endInput() below,
//   which sends neither commit nor response.create in this mode.
// - Server->client events `input_audio_buffer.speech_started` /
//   `input_audio_buffer.speech_stopped` are documented event type strings
//   for server_vad — handled in handleMessage() below.
// - Whether response.create is still required after server_vad commits a
//   turn is NOT clearly and consistently documented (one page's prose
//   suggests it's automatic, but does not say so in an unambiguous,
//   directly-quotable sentence) — this repo has no Grok API credentials to
//   verify live, so this is implemented per the more specific "commit is
//   forbidden" statement and left unverified beyond that; see this
//   session's report for the exact wording found.
function buildGrokSessionConfig(options, config) {
    const tools = options.contentToolsEnabled ? buildGrokTools(options.toolDeclarations) : [];
    const turnDetection = options.voiceMode === 'tap_to_start'
        ? {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700,
        }
        : null;
    return {
        instructions: String(options.systemInstructionText || ''),
        voice: normalizeGrokVoiceId(options.voiceName || config.voiceId),
        turn_detection: turnDetection,
        audio: {
            input: {
                format: { type: 'audio/pcm', rate: 16000 },
                transcription: { model: 'grok-transcribe' },
            },
            output: {
                format: { type: 'audio/pcm', rate: 24000 },
            },
        },
        ...(tools.length ? { tools } : {}),
    };
}

class GrokVoiceProvider {
    constructor(options = {}) {
        this.name = 'grok';
        this.apiKey = options.apiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY || '';
        this.model = options.model || DEFAULT_GROK_MODEL;
        this.realtimeUrl = options.realtimeUrl || DEFAULT_GROK_REALTIME_URL;
        this.voiceId = normalizeGrokVoiceId(options.voiceId || DEFAULT_GROK_VOICE_ID);
        this.webSocketFactory = options.webSocketFactory || ((url, socketOptions) => new WebSocket(url, socketOptions));
    }

    createSession(options = {}) {
        return new GrokVoiceProviderSession({
            config: this,
            options,
            instanceId: makeInstanceId(),
        });
    }
}

class GrokVoiceProviderSession {
    constructor({ config, options, instanceId }) {
        this.name = 'grok';
        this.model = config.model;
        this.voiceName = normalizeGrokVoiceId(options.voiceName || config.voiceId);
        this.voiceConfigSource = options.voiceName ? 'session_start' : 'default';
        this.systemInstructionText = String(options.systemInstructionText || '');
        this.systemInstructionMeta = options.systemInstructionMeta || {};
        this.promptSource = options.promptSource || 'provider_default';
        this.rotationReason = options.rotationReason || 'initial';
        // Fresh instance per interrupted turn (see markDraining()/interrupt()
        // below) is what makes lifecycle isolation an actual guarantee: once
        // an instance is draining, realtimeServer.js never holds a reference
        // to it as `providerSession` again, so it can never be handed a new
        // generation via beginResponse(). rotateAfterOutputComplete stays
        // false -- normal, uninterrupted completed turns still reuse the
        // same connection (no reason to isolate a turn that finished on its
        // own terms).
        this.rotateOnInterrupt = true;
        this.rotateAfterOutputComplete = false;
        // active: eligible for beginResponse(). draining: this.active is
        // permanently null, socket stays open only to receive late events
        // for logging/cleanup. closed: socket closed, terminal.
        this.lifecycleState = 'active';
        this.drainReason = null;
        this.drainStartedAt = null;
        this.drainTimer = null;
        this.voiceMode = options.voiceMode === 'tap_to_start' ? 'tap_to_start' : 'hold_to_talk';
        this.onUserSpeechStarted = typeof options.onUserSpeechStarted === 'function' ? options.onUserSpeechStarted : null;
        this.onUserSpeechStopped = typeof options.onUserSpeechStopped === 'function' ? options.onUserSpeechStopped : null;
        this.config = config;
        this.options = options;
        this.instanceId = instanceId;
        this.socket = null;
        this.connectPromise = null;
        this.closed = false;
        this.active = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        this.sessionLog = () => {};
    }

    connect(log = () => {}) {
        if (this.connectPromise) return this.connectPromise;
        if (!this.config.apiKey) {
            return Promise.reject(Object.assign(new Error('grok_api_key_missing'), { code: 'grok_api_key_missing' }));
        }
        this.sessionLog = log;
        const url = new URL(this.config.realtimeUrl);
        url.searchParams.set('model', this.config.model);

        this.connectPromise = new Promise((resolve, reject) => {
            const socket = this.config.webSocketFactory(url, {
                headers: { authorization: `Bearer ${this.config.apiKey}` },
            });
            this.socket = socket;
            let settled = false;

            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(Object.assign(new Error(safeErrorMessage(error)), { code: 'grok_connect_failed' }));
            };

            socket.once('error', fail);
            socket.once('open', () => {
                if (this.closed) {
                    try { socket.close(); } catch { /* already closing */ }
                    fail(new Error('provider_session_closed'));
                    return;
                }
                settled = true;
                socket.off('error', fail);
                socket.on('error', (error) => this.failActive('grok_socket_error', error));
                socket.on('message', (data) => this.handleMessage(data));
                socket.on('close', (code) => {
                    if (!this.closed && this.active) this.failActive('grok_socket_closed', new Error(String(code)));
                });
                const sentSessionConfig = buildGrokSessionConfig(this.options, this.config);
                // TEMPORARY diagnostic (tap_to_start only) for the
                // provider-native-VAD-not-working investigation — logs
                // exactly what session.update was sent. No API key, no
                // system prompt text, no audio.
                if (this.voiceMode === 'tap_to_start') {
                    log('grok_vad_diag_session_update_sent', {
                        providerInstanceId: this.instanceId,
                        model: this.model,
                        turnDetection: JSON.stringify(sentSessionConfig.turn_detection),
                        inputAudioFormat: JSON.stringify(sentSessionConfig.audio?.input?.format),
                        outputAudioFormat: JSON.stringify(sentSessionConfig.audio?.output?.format),
                    });
                }
                this.sendRaw({
                    type: 'session.update',
                    session: sentSessionConfig,
                });
                log('provider_connected', {
                    provider: this.name,
                    providerInstanceId: this.instanceId,
                    model: this.model,
                    voiceName: this.voiceName,
                });
                this.flushPendingAudio();
                resolve();
            });
        });

        return this.connectPromise;
    }

    sendRaw(payload) {
        if (this.socket?.readyState !== WebSocket.OPEN) return false;
        this.socket.send(JSON.stringify(payload));
        return true;
    }

    beginResponse(context) {
        if (this.closed) return;
        this.active = {
            ...context,
            audioStarted: false,
            chunkIndex: 0,
            lastUserTranscript: '',
            pendingToolCalls: [],
            toolContinuationInProgress: false,
        };
        this.connect(context.log).catch((error) => this.failActive('grok_connect_failed', error));
    }

    sendAudio(buffer) {
        if (this.closed || !Buffer.isBuffer(buffer) || buffer.length === 0) return;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendAudioNow(buffer);
            return;
        }
        if (this.pendingAudioBytes + buffer.length > MAX_PENDING_AUDIO_BYTES) {
            this.failActive('grok_pending_audio_overflow', new Error('Pending audio limit exceeded'));
            return;
        }
        this.pendingAudio.push(Buffer.from(buffer));
        this.pendingAudioBytes += buffer.length;
        this.connect(this.active?.log || this.sessionLog).catch((error) => this.failActive('grok_connect_failed', error));
    }

    sendAudioNow(buffer) {
        this.sendRaw({ type: 'input_audio_buffer.append', audio: buffer.toString('base64') });
    }

    flushPendingAudio() {
        for (const buffer of this.pendingAudio.splice(0)) this.sendAudioNow(buffer);
        this.pendingAudioBytes = 0;
    }

    async endInput(context) {
        await this.connect(context.log);
        if (!this.isActive(context) || context.signal.cancelled) return;
        if (this.voiceMode === 'tap_to_start') {
            // server_vad already committed the buffer server-side once it
            // detected the pause (input_audio_buffer.speech_stopped, handled
            // in handleMessage() below) — xAI's docs state commit is
            // forbidden while server_vad is active, so nothing is sent here.
            return;
        }
        this.sendRaw({ type: 'input_audio_buffer.commit' });
        this.sendRaw({ type: 'response.create' });
    }

    async sendText(text, context) {
        await this.connect(context.log);
        if (!this.isActive(context) || context.signal.cancelled) return;
        this.sendRaw({
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: String(text).trim().slice(0, 1200) }],
            },
        });
        this.sendRaw({ type: 'response.create' });
    }

    isActive(context) {
        return Boolean(this.active && this.active.generationId === context.generationId && !this.closed);
    }

    interrupt(reason = 'interrupt', context = {}) {
        const active = this.active;
        if (active?.signal && !active.signal.cancelled && typeof active.signal.cancel === 'function') {
            active.signal.cancel(reason);
        }
        this.sendRaw({ type: 'response.cancel' });
        this.sendRaw({ type: 'input_audio_buffer.clear' });
        active?.onSessionEvent?.({
            type: 'provider_interrupt_ack',
            interrupted_generation_id: context.interrupted_generation_id || active?.generationId || null,
            interrupted_turn_id: context.interrupted_turn_id || active?.turnId || null,
            interrupted_response_id: context.interrupted_response_id || active?.responseId || null,
            provider_instance_id: this.instanceId,
            matched: true,
            ignored_for_active_generation: true,
            elapsed_ms: 0,
        });
        this.active = null;
        // If a response was actually in flight, Grok may still send a late,
        // unqualified response.done/delta/error for it -- markDraining()
        // keeps the socket alive just long enough to log and discard those,
        // without ever letting this instance be reassigned to a new turn
        // (realtimeServer.js's rotateOnInterrupt path swaps in a fresh
        // instance for the next turn before this one's late events arrive).
        if (active) {
            this.markDraining(reason);
        } else {
            this.hardClose();
        }
    }

    markDraining(reason) {
        if (this.lifecycleState !== 'active') return;
        this.lifecycleState = 'draining';
        this.drainReason = reason;
        this.drainStartedAt = Date.now();
        const timeoutMs = Math.max(0, Number(process.env.GROK_DRAIN_TIMEOUT_MS || 5000));
        this.drainTimer = setTimeout(() => this.finishDraining('drain_timeout'), timeoutMs);
        (this.active?.log || this.sessionLog)('provider_instance_draining', {
            providerInstanceId: this.instanceId,
            lifecycleState: this.lifecycleState,
            drainReason: reason,
        });
    }

    logLateEvent(eventType) {
        this.sessionLog('provider_late_event_ignored', {
            providerInstanceId: this.instanceId,
            lifecycleState: this.lifecycleState,
            lateEventIgnored: true,
            lateEventType: eventType,
        });
    }

    finishDraining(drainReason) {
        if (this.lifecycleState === 'closed') return;
        if (this.drainTimer) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        const drainDurationMs = this.drainStartedAt ? Date.now() - this.drainStartedAt : 0;
        this.sessionLog('provider_instance_drain_completed', {
            providerInstanceId: this.instanceId,
            drainReason,
            drainDurationMs,
        });
        this.hardClose();
    }

    hardClose() {
        this.lifecycleState = 'closed';
        this.closed = true;
        this.active = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        if (this.drainTimer) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        try {
            if (this.socket?.readyState < WebSocket.CLOSING) this.socket.close();
        } catch { /* best effort */ }
        this.socket = null;
        this.connectPromise = null;
    }

    // Public API used by realtimeServer.js's rotateProviderSession(). An
    // instance with nothing in flight (this.active already null -- e.g.
    // rotation triggered by something other than an interrupt) has nothing
    // to drain and can close immediately; one with a response in flight
    // drains first (see interrupt()/markDraining()) so a late terminal
    // event still gets logged instead of silently vanishing mid-close.
    destroySession(reason = 'destroy_session') {
        if (this.active) {
            this.markDraining(reason);
            return;
        }
        this.hardClose();
    }

    close() {
        this.hardClose();
    }

    failActive(reason, error) {
        const active = this.active;
        const message = safeErrorMessage(error);
        (active?.log || this.sessionLog)('provider_error', {
            provider: this.name,
            providerInstanceId: this.instanceId,
            reason,
            message,
        });
        active?.onEvent?.({
            type: 'response.failed',
            reason,
            provider: this.name,
            provider_instance_id: this.instanceId,
            message,
        });
    }

    emitAudioChunk(audioBase64) {
        const active = this.active;
        if (!active || active.signal.cancelled || !audioBase64) return;
        if (!active.audioStarted) {
            active.audioStarted = true;
            active.onEvent({
                type: 'audio.start',
                provider_instance_id: this.instanceId,
                format: 'audio/pcm;rate=24000',
            });
        }
        active.onAudioChunk({
            type: 'audio.chunk',
            chunk_index: active.chunkIndex++,
            mime_type: 'audio/pcm;rate=24000',
            audio_base64: audioBase64,
            provider_instance_id: this.instanceId,
        });
    }

    emitUserTranscript(text) {
        const active = this.active;
        const next = String(text || '');
        if (!active || !next) return;
        const previous = active.lastUserTranscript;
        const delta = previous && next.startsWith(previous) ? next.slice(previous.length) : next;
        active.lastUserTranscript = next;
        if (delta) active.onEvent({ type: 'transcript.user', text: delta, provider_instance_id: this.instanceId });
    }

    async continueAfterToolCalls(active) {
        const calls = active.pendingToolCalls.splice(0);
        if (!calls.length || active.toolContinuationInProgress) return false;
        active.toolContinuationInProgress = true;

        const outputs = await Promise.all(calls.map(async (call) => {
            const name = String(call.name || '');
            const handler = this.options.toolHandlers?.[name];
            let args = {};
            try { args = JSON.parse(call.arguments || '{}'); } catch { args = {}; }
            active.onEvent({
                type: 'tool.call',
                tool_name: name,
                provider_instance_id: this.instanceId,
            });
            let result;
            try {
                result = typeof handler === 'function'
                    ? await handler({
                        args,
                        functionCall: call,
                        generationId: active.generationId,
                        responseId: active.responseId,
                        turnId: active.turnId,
                        providerInstanceId: this.instanceId,
                    })
                    : { error: `unsupported_tool:${name || 'unknown'}` };
            } catch (error) {
                result = { error: safeErrorMessage(error) };
            }
            return { call, name, result: result || {} };
        }));

        if (this.closed || this.active !== active || active.signal.cancelled) return true;
        for (const output of outputs) {
            this.sendRaw({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: output.call.call_id,
                    output: JSON.stringify(output.result),
                },
            });
        }
        active.onEvent({
            type: 'tool.response',
            tool_names: outputs.map((output) => output.name).filter(Boolean),
            provider_instance_id: this.instanceId,
        });
        active.toolContinuationInProgress = false;
        this.sendRaw({ type: 'response.create' });
        return true;
    }

    async finishResponse() {
        const active = this.active;
        if (!active || active.signal.cancelled) return;
        if (await this.continueAfterToolCalls(active)) return;
        active.onEvent({
            type: 'audio.end',
            provider_instance_id: this.instanceId,
            cause: 'response.done',
        });
        if (this.active === active) this.active = null;
    }

    handleMessage(data) {
        let event;
        try {
            event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
        } catch {
            return;
        }
        const type = String(event.type || '');

        // TEMPORARY diagnostic (tap_to_start only) for the
        // provider-native-VAD-not-working investigation — logs the `type`
        // of EVERY incoming message, including ones this file has no
        // case for at all, so an event we're not expecting is still
        // visible. session.created/session.updated get one extra line
        // capturing the actual confirmed turn_detection value, since that
        // is the single most important fact for this investigation: does
        // the server actually confirm server_vad, or silently keep/revert
        // to null? Never logs API keys, audio, or transcript content.
        if (this.voiceMode === 'tap_to_start') {
            const log = this.active?.log || this.sessionLog || (() => {});
            log('grok_vad_diag_message_type', {
                providerInstanceId: this.instanceId,
                type: type || '(missing)',
            });
            if (type === 'session.created' || type === 'session.updated') {
                log('grok_vad_diag_session_confirmation', {
                    providerInstanceId: this.instanceId,
                    type,
                    turnDetection: JSON.stringify(event.session?.turn_detection ?? null),
                    inputAudioFormat: JSON.stringify(event.session?.audio?.input?.format ?? null),
                });
            }
            if (type === 'error') {
                log('grok_vad_diag_error_event', {
                    providerInstanceId: this.instanceId,
                    code: event.error?.code || event.code || 'unknown',
                    message: String(event.error?.message || event.message || '').slice(0, 300),
                });
            }
        }

        // Provider-native VAD signals (tap_to_start only) — these fire
        // independently of whether a generation is currently "active"
        // server-side. speech_started is exactly what CREATES the next
        // active generation (via realtimeServer.js's callback), so this
        // must run before the `!this.active` guard below, not after it.
        if (type === 'input_audio_buffer.speech_started') {
            if (this.lifecycleState === 'draining') {
                this.logLateEvent(type);
                return;
            }
            if (this.voiceMode === 'tap_to_start') this.onUserSpeechStarted?.();
            return;
        }
        if (type === 'input_audio_buffer.speech_stopped') {
            if (this.lifecycleState === 'draining') {
                this.logLateEvent(type);
                return;
            }
            if (this.voiceMode === 'tap_to_start') this.onUserSpeechStopped?.();
            return;
        }

        if (this.lifecycleState === 'draining') {
            this.logLateEvent(type);
            // A terminal event settles the drain immediately instead of
            // waiting out the full timeout; a non-terminal one (delta,
            // transcript fragment, benign error) just gets logged and
            // dropped -- there is no generation left for it to belong to.
            if (type === 'response.done' || type === 'response.cancelled' || type === 'error') {
                this.finishDraining(type);
            }
            return;
        }

        if (!this.active || this.active.signal.cancelled) return;

        if (type === 'conversation.item.input_audio_transcription.updated'
            || type === 'conversation.item.input_audio_transcription.completed') {
            this.emitUserTranscript(event.transcript || event.text || '');
            return;
        }
        if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
            this.emitAudioChunk(event.delta || event.audio);
            return;
        }
        if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
            const text = event.delta || event.transcript || '';
            if (text) this.active.onEvent({ type: 'transcript.model', text, provider_instance_id: this.instanceId });
            return;
        }
        if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
            return;
        }
        if (type === 'response.function_call_arguments.done') {
            this.active.pendingToolCalls.push({
                call_id: event.call_id,
                name: event.name,
                arguments: event.arguments,
            });
            return;
        }
        if (type === 'response.done') {
            this.finishResponse().catch((error) => this.failActive('grok_response_finalize_failed', error));
            return;
        }
        if (type === 'response.cancelled') {
            this.active.onEvent({ type: 'response.cancelled', provider_instance_id: this.instanceId });
            this.active = null;
            return;
        }
        if (type === 'error') {
            if (isBenignCancellationRace(event)) {
                (this.active?.log || this.sessionLog)('benign_cancel_race', {
                    providerInstanceId: this.instanceId,
                    code: event.error?.code || event.code || 'unknown',
                    message: String(event.error?.message || event.message || '').slice(0, 300),
                });
                return;
            }
            this.failActive('grok_provider_error', new Error(event.error?.message || event.message || 'grok_provider_error'));
        }
    }
}

module.exports = {
    GrokVoiceProvider,
    GrokVoiceProviderSession,
    DEFAULT_GROK_MODEL,
    DEFAULT_GROK_REALTIME_URL,
    isBenignCancellationRace,
    buildGrokSessionConfig,
    buildGrokTools,
    normalizeJsonSchema,
};

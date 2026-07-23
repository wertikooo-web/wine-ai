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
                parameters: declaration.parameters || { type: 'object', properties: {} },
            };
        })
        .filter(Boolean);
}

function buildGrokSessionConfig(options, config) {
    const tools = options.contentToolsEnabled ? buildGrokTools(options.toolDeclarations) : [];
    return {
        instructions: String(options.systemInstructionText || ''),
        voice: normalizeGrokVoiceId(options.voiceName || config.voiceId),
        turn_detection: null,
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
        this.rotateOnInterrupt = false;
        this.rotateAfterOutputComplete = false;
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
                this.sendRaw({
                    type: 'session.update',
                    session: buildGrokSessionConfig(this.options, this.config),
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
    }

    close() {
        this.closed = true;
        this.active = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        try {
            if (this.socket?.readyState < WebSocket.CLOSING) this.socket.close();
        } catch { /* best effort */ }
        this.socket = null;
        this.connectPromise = null;
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
        if (!this.active || this.active.signal.cancelled) return;
        const type = String(event.type || '');

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
            this.failActive('grok_provider_error', new Error(event.error?.message || event.message || 'grok_provider_error'));
        }
    }
}

module.exports = {
    GrokVoiceProvider,
    GrokVoiceProviderSession,
    DEFAULT_GROK_MODEL,
    DEFAULT_GROK_REALTIME_URL,
    buildGrokSessionConfig,
    buildGrokTools,
};

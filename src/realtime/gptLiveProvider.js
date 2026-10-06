'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const DEFAULT_GPT_LIVE_MODEL = process.env.GPT_LIVE_MODEL || 'gpt-live-1';
const DEFAULT_GPT_LIVE_URL = process.env.GPT_LIVE_URL || 'wss://api.openai.com/v1/live/sessions';
const DEFAULT_GPT_LIVE_VOICE = process.env.GPT_LIVE_VOICE || 'willow';
const GPT_LIVE_VOICES = Object.freeze([
    'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam',
    'meridian', 'bossa', 'tempo', 'beacon', 'delta', 'cinder',
]);
const MAX_PENDING_AUDIO_BYTES = Math.max(64 * 1024, Number(process.env.GPT_LIVE_PENDING_AUDIO_MAX_BYTES || 512 * 1024));

function safeErrorMessage(error) {
    return String(error?.message || error || 'GPT Live error')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
        .slice(0, 300);
}

function makeInstanceId() {
    return `gpt_live_session_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeVoice(value) {
    const wanted = String(value || DEFAULT_GPT_LIVE_VOICE).trim().toLowerCase();
    return GPT_LIVE_VOICES.includes(wanted) ? wanted : DEFAULT_GPT_LIVE_VOICE;
}

class GptLiveProvider {
    constructor(options = {}) {
        this.name = 'gpt_live';
        this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
        this.model = options.model || DEFAULT_GPT_LIVE_MODEL;
        this.liveUrl = options.liveUrl || DEFAULT_GPT_LIVE_URL;
        this.voice = normalizeVoice(options.voice || DEFAULT_GPT_LIVE_VOICE);
        this.backendModel = options.backendModel || process.env.GPT_LIVE_BACKEND_MODEL || 'gpt-6-luna';
        this.webSocketFactory = options.webSocketFactory || ((url, socketOptions) => new WebSocket(url, socketOptions));
    }

    createSession(options = {}) {
        return new GptLiveProviderSession({ config: this, options, instanceId: makeInstanceId() });
    }
}

class GptLiveProviderSession {
    constructor({ config, options, instanceId }) {
        this.name = 'gpt_live';
        this.model = config.model;
        this.voiceName = normalizeVoice(options.voiceName || config.voice);
        this.voiceConfigSource = options.voiceName ? 'session_start' : 'default';
        this.systemInstructionText = String(options.systemInstructionText || '');
        this.systemInstructionMeta = options.systemInstructionMeta || {};
        this.promptSource = options.promptSource || 'provider_default';
        this.rotationReason = options.rotationReason || 'initial';
        this.rotateOnInterrupt = true;
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
        this.chunkIndex = 0;
        this.sessionLog = () => {};
    }

    connect(log = () => {}) {
        if (this.connectPromise) return this.connectPromise;
        if (!this.config.apiKey) return Promise.reject(Object.assign(new Error('openai_api_key_missing'), { code: 'openai_api_key_missing' }));
        this.sessionLog = log;
        this.connectPromise = new Promise((resolve, reject) => {
            const socket = this.config.webSocketFactory(this.config.liveUrl, {
                headers: { Authorization: `Bearer ${this.config.apiKey}` },
            });
            this.socket = socket;
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                reject(Object.assign(new Error(safeErrorMessage(error)), { code: 'gpt_live_connect_failed' }));
            };
            socket.once('error', fail);
            socket.once('open', () => {
                if (this.closed) {
                    try { socket.close(); } catch { /* noop */ }
                    fail(new Error('provider_session_closed'));
                    return;
                }
                socket.off('error', fail);
                socket.on('error', (error) => this.failActive('gpt_live_socket_error', error));
                socket.on('message', (data) => this.handleMessage(data));
                socket.on('close', (code) => {
                    if (!this.closed && this.active) this.failActive('gpt_live_socket_closed', new Error(String(code)));
                });
                this.sendRaw({
                    type: 'session.start',
                    event_id: `start_${this.instanceId}`,
                    session: {
                        model: this.config.model,
                        instructions: this.systemInstructionText || 'Reply briefly and naturally in the user language.',
                        audio: {
                            format: { type: 'audio/pcm', rate: 16000 },
                            output: { voice: this.voiceName },
                        },
                        delegation: {
                            type: 'responses',
                            responses: {
                                model: this.config.backendModel,
                                instructions: 'Answer accurately and concisely. Use the live conversation context supplied by the voice layer.',
                            },
                        },
                    },
                });
                settled = true;
                log('provider_connected', { provider: this.name, providerInstanceId: this.instanceId, model: this.model, voiceName: this.voiceName });
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
        this.active = { ...context, audioStarted: false, lastUserTranscript: '' };
        this.chunkIndex = 0;
        this.connect(context.log).catch((error) => this.failActive('gpt_live_connect_failed', error));
    }

    sendAudio(buffer) {
        if (this.closed || !Buffer.isBuffer(buffer) || !buffer.length) return;
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendRaw({ type: 'session.input_audio.append', audio: buffer.toString('base64') });
            return;
        }
        if (this.pendingAudioBytes + buffer.length > MAX_PENDING_AUDIO_BYTES) {
            this.failActive('gpt_live_pending_audio_overflow', new Error('Pending audio limit exceeded'));
            return;
        }
        this.pendingAudio.push(Buffer.from(buffer));
        this.pendingAudioBytes += buffer.length;
        this.connect(this.active?.log || this.sessionLog).catch((error) => this.failActive('gpt_live_connect_failed', error));
    }

    flushPendingAudio() {
        for (const buffer of this.pendingAudio.splice(0)) this.sendRaw({ type: 'session.input_audio.append', audio: buffer.toString('base64') });
        this.pendingAudioBytes = 0;
    }

    async endInput(context) {
        await this.connect(context.log);
        // GPT-Live is full duplex and owns turn detection. Audio is streamed
        // continuously; there is intentionally no explicit commit/create.
    }

    async sendText(text, context) {
        await this.connect(context.log);
        if (!this.isActive(context) || context.signal.cancelled) return;
        this.sendRaw({ type: 'session.commentary.append', delegation_id: null, content: String(text).trim().slice(0, 1200) });
    }

    isActive(context) {
        return Boolean(this.active && this.active.generationId === context.generationId && !this.closed);
    }

    interrupt(reason = 'interrupt', context = {}) {
        const active = this.active;
        if (active?.signal && !active.signal.cancelled && typeof active.signal.cancel === 'function') active.signal.cancel(reason);
        this.sendRaw({ type: 'session.input_audio.mute' });
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
        this.hardClose();
    }

    destroySession() { this.hardClose(); }
    close() { this.hardClose(); }

    hardClose() {
        this.closed = true;
        this.active = null;
        this.pendingAudio = [];
        this.pendingAudioBytes = 0;
        try { this.sendRaw({ type: 'session.close' }); } catch { /* noop */ }
        try { if (this.socket?.readyState < WebSocket.CLOSING) this.socket.close(); } catch { /* noop */ }
        this.socket = null;
        this.connectPromise = null;
    }

    failActive(reason, error) {
        const active = this.active;
        const message = safeErrorMessage(error);
        (active?.log || this.sessionLog)('provider_error', { provider: this.name, providerInstanceId: this.instanceId, reason, message });
        active?.onEvent?.({ type: 'response.failed', reason, provider: this.name, provider_instance_id: this.instanceId, message });
    }

    emitAudioChunk(audioBase64) {
        const active = this.active;
        if (!active || active.signal.cancelled || !audioBase64) return;
        if (!active.audioStarted) {
            active.audioStarted = true;
            active.onEvent({ type: 'audio.start', provider_instance_id: this.instanceId, format: 'audio/pcm;rate=16000' });
        }
        active.onAudioChunk({ type: 'audio.chunk', chunk_index: this.chunkIndex++, mime_type: 'audio/pcm;rate=16000', audio_base64: audioBase64, provider_instance_id: this.instanceId });
    }

    handleMessage(data) {
        let event;
        try { event = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch { return; }
        const type = String(event.type || '');
        if (type === 'error') {
            this.failActive('gpt_live_provider_error', new Error(event.error?.message || event.message || 'gpt_live_provider_error'));
            return;
        }
        if (!this.active || this.active.signal.cancelled) return;
        if (type === 'session.output_audio.delta') {
            this.emitAudioChunk(event.delta);
            return;
        }
        if (type === 'session.input_transcript.delta') {
            if (event.delta) this.active.onEvent({ type: 'transcript.user', text: event.delta, provider_instance_id: this.instanceId });
            return;
        }
        if (type === 'session.output_transcript.delta') {
            if (event.delta) this.active.onEvent({ type: 'transcript.model', text: event.delta, provider_instance_id: this.instanceId });
            return;
        }
        if (type === 'session.closed') {
            this.active.onEvent({ type: 'audio.end', provider_instance_id: this.instanceId, cause: 'session.closed' });
            this.active = null;
        }
    }
}

module.exports = {
    GptLiveProvider,
    GptLiveProviderSession,
    DEFAULT_GPT_LIVE_MODEL,
    DEFAULT_GPT_LIVE_URL,
    DEFAULT_GPT_LIVE_VOICE,
    GPT_LIVE_VOICES,
};

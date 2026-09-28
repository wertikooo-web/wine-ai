'use strict';

// Per-realtime-session usage meter. One instance per WebSocket session
// (realtimeServer.js), shared by every provider instance that session
// rotates through, so reconnects/rotations add usage to the SAME record
// instead of creating new ones. finalize() is idempotent: only the first
// call returns a record; duplicate finalization (socket close + error +
// provider close) returns null.
//
// Every public method swallows its own errors — metering must never throw
// into the realtime path.

const { emptyUsage, addUsage, normalizeGeminiUsage, normalizeRealtimeCompatUsage } = require('./usageNormalize');
const { CATEGORIES } = require('./pricing');

const MAX_RAW_EVENTS = 400;
const PCM16_BYTES_PER_SAMPLE = 2;

function categoryForProvider(provider) {
    if (provider === 'gemini') return CATEGORIES.REALTIME_GEMINI;
    if (provider === 'grok' || provider === 'xai') return CATEGORIES.REALTIME_GROK;
    return CATEGORIES.OTHER;
}

function base64DecodedBytes(b64) {
    const s = String(b64 || '');
    if (!s) return 0;
    const padding = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

function createSessionUsageMeter({ sessionId, provider, model, voiceMode = null, now = () => Date.now() } = {}) {
    const startedAt = now();
    const providerName = String(provider || 'unknown');
    const state = {
        turns: 0,
        inputAudioBytes: 0,
        inputSampleRate: 16000,
        outputAudioBytes: 0,
        outputSampleRate: 24000,
        providerInstances: new Set(),
        rawEvents: [],
        droppedRawEvents: 0,
        actualUsage: null,
        finalized: false,
    };

    function safe(fn) {
        return (...args) => {
            try {
                return fn(...args);
            } catch (error) {
                return undefined;
            }
        };
    }

    const meter = {
        sessionId,
        provider: providerName,
        model: model || null,

        noteTurn: safe(() => { state.turns += 1; }),

        noteInputAudioBytes: safe((bytes, sampleRate) => {
            state.inputAudioBytes += Math.max(0, Number(bytes) || 0);
            if (Number(sampleRate) > 0) state.inputSampleRate = Number(sampleRate);
        }),

        noteOutputAudioChunk: safe((event) => {
            state.outputAudioBytes += base64DecodedBytes(event?.audio_base64);
            if (Number(event?.sample_rate) > 0) state.outputSampleRate = Number(event.sample_rate);
        }),

        // Called by provider adapters with the provider's own usage payload.
        // `kind` selects the normalizer: 'gemini_usage_metadata' or
        // 'realtime_usage' (xAI response.done usage).
        onProviderUsage: safe((raw, { kind, providerInstanceId } = {}) => {
            if (state.finalized || !raw) return;
            const normalized = kind === 'realtime_usage'
                ? normalizeRealtimeCompatUsage(raw)
                : normalizeGeminiUsage(raw);
            if (providerInstanceId) state.providerInstances.add(providerInstanceId);
            if (state.rawEvents.length < MAX_RAW_EVENTS) {
                state.rawEvents.push({ at: new Date(now()).toISOString(), kind: kind || 'gemini_usage_metadata', provider_instance_id: providerInstanceId || null, usage: raw });
            } else {
                state.droppedRawEvents += 1;
            }
            if (normalized) state.actualUsage = addUsage(state.actualUsage, normalized);
        }),

        noteProviderInstance: safe((instanceId) => { if (instanceId) state.providerInstances.add(instanceId); }),

        isFinalized: () => state.finalized,

        finalize: safe(({ endReason = 'unknown' } = {}) => {
            if (state.finalized) return null;
            state.finalized = true;
            const endedAt = now();
            const durationMs = Math.max(0, endedAt - startedAt);
            const inputSeconds = state.inputAudioBytes / (state.inputSampleRate * PCM16_BYTES_PER_SAMPLE);
            const outputSeconds = state.outputAudioBytes / (state.outputSampleRate * PCM16_BYTES_PER_SAMPLE);
            const used = state.turns > 0 || state.inputAudioBytes > 0;
            const usage = state.actualUsage ? { ...state.actualUsage } : emptyUsage();
            usage.audio_input_seconds = round(inputSeconds, 3);
            usage.audio_output_seconds = round(outputSeconds, 3);
            // Per-minute billing (Grok) is estimated from measured session
            // time while the session was actually used.
            usage.billable_seconds = used ? round(durationMs / 1000, 3) : 0;
            return {
                record_id: `rt:${sessionId}`,
                kind: 'realtime_session',
                session_id: sessionId,
                occurred_at: new Date(startedAt).toISOString(),
                ended_at: new Date(endedAt).toISOString(),
                duration_ms: durationMs,
                category: categoryForProvider(providerName),
                provider: providerName,
                model: model || null,
                operation: 'realtime_session',
                voice_mode: voiceMode,
                status: state.turns > 0 ? 'completed' : 'no_conversation',
                end_reason: String(endReason).slice(0, 64),
                turn_count: state.turns,
                provider_connections: state.providerInstances.size,
                usage,
                usage_basis: state.actualUsage ? 'actual' : 'estimated',
                usage_raw: {
                    provider_usage_events: state.rawEvents,
                    dropped_events: state.droppedRawEvents,
                    measured: {
                        input_audio_bytes: state.inputAudioBytes,
                        input_sample_rate: state.inputSampleRate,
                        output_audio_bytes: state.outputAudioBytes,
                        output_sample_rate: state.outputSampleRate,
                        duration_ms: durationMs,
                    },
                },
            };
        }),
    };
    return meter;
}

function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

module.exports = { createSessionUsageMeter, categoryForProvider, base64DecodedBytes };

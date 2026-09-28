'use strict';

// Converts provider-specific usage payloads into one normalized shape that
// pricing.js can price. The RAW payload is always persisted separately, so a
// bug here can be fixed later and history re-normalized.
//
// Normalized fields (all numbers, absent = 0):
//   input_text_tokens, input_audio_tokens, input_other_tokens,
//   output_text_tokens, output_audio_tokens, output_other_tokens,
//   cached_tokens, total_tokens, requests, input_chars,
//   audio_input_seconds, audio_output_seconds, billable_seconds

const SUM_FIELDS = [
    'input_text_tokens', 'input_audio_tokens', 'input_other_tokens',
    'output_text_tokens', 'output_audio_tokens', 'output_other_tokens',
    'cached_tokens', 'total_tokens', 'requests', 'input_chars',
    'audio_input_seconds', 'audio_output_seconds', 'billable_seconds',
];

function n(value) {
    const x = Number(value);
    return Number.isFinite(x) && x > 0 ? x : 0;
}

function emptyUsage() {
    const usage = {};
    for (const key of SUM_FIELDS) usage[key] = 0;
    return usage;
}

function addUsage(target, source) {
    const out = target || emptyUsage();
    for (const key of SUM_FIELDS) out[key] = n(out[key]) + n(source?.[key]);
    return out;
}

function splitByModality(details) {
    const byModality = { TEXT: 0, AUDIO: 0, OTHER: 0 };
    if (!Array.isArray(details)) return { byModality, itemized: 0 };
    let itemized = 0;
    for (const item of details) {
        const count = n(item?.tokenCount);
        const modality = String(item?.modality || '').toUpperCase();
        if (modality === 'TEXT') byModality.TEXT += count;
        else if (modality === 'AUDIO') byModality.AUDIO += count;
        else byModality.OTHER += count;
        itemized += count;
    }
    return { byModality, itemized };
}

// @google/genai UsageMetadata / GenerateContentResponseUsageMetadata:
// promptTokenCount, responseTokenCount (Live) or candidatesTokenCount
// (generateContent), toolUsePromptTokenCount, thoughtsTokenCount,
// cachedContentTokenCount, totalTokenCount, promptTokensDetails[],
// responseTokensDetails[] / candidatesTokensDetails[], each detail being
// { modality, tokenCount }.
function hasGeminiUsage(meta) {
    return Boolean(meta && typeof meta === 'object' && (
        meta.totalTokenCount !== undefined
        || meta.promptTokenCount !== undefined
        || meta.responseTokenCount !== undefined
        || meta.candidatesTokenCount !== undefined
    ));
}

function normalizeGeminiUsage(meta) {
    const usage = emptyUsage();
    if (!hasGeminiUsage(meta)) return null;
    const promptTotal = n(meta.promptTokenCount);
    const responseTotal = n(meta.responseTokenCount) || n(meta.candidatesTokenCount);
    const promptDetails = splitByModality(meta.promptTokensDetails);
    const responseDetails = splitByModality(meta.responseTokensDetails || meta.candidatesTokensDetails);

    usage.input_text_tokens = promptDetails.byModality.TEXT + n(meta.toolUsePromptTokenCount);
    usage.input_audio_tokens = promptDetails.byModality.AUDIO;
    usage.input_other_tokens = promptDetails.byModality.OTHER + Math.max(0, promptTotal - promptDetails.itemized);
    usage.output_text_tokens = responseDetails.byModality.TEXT + n(meta.thoughtsTokenCount);
    usage.output_audio_tokens = responseDetails.byModality.AUDIO;
    usage.output_other_tokens = responseDetails.byModality.OTHER + Math.max(0, responseTotal - responseDetails.itemized);
    usage.cached_tokens = n(meta.cachedContentTokenCount);
    usage.total_tokens = n(meta.totalTokenCount)
        || (promptTotal + responseTotal + n(meta.toolUsePromptTokenCount) + n(meta.thoughtsTokenCount));
    return usage;
}

// OpenAI-realtime-compatible usage object carried on xAI's response.done
// (event.response.usage): input_tokens, output_tokens, total_tokens,
// input_token_details { text_tokens, audio_tokens, cached_tokens },
// output_token_details { text_tokens, audio_tokens }.
function normalizeRealtimeCompatUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.total_tokens === undefined && raw.input_tokens === undefined && raw.output_tokens === undefined) return null;
    const usage = emptyUsage();
    const inDetails = raw.input_token_details || {};
    const outDetails = raw.output_token_details || {};
    usage.input_text_tokens = n(inDetails.text_tokens);
    usage.input_audio_tokens = n(inDetails.audio_tokens);
    usage.input_other_tokens = Math.max(0, n(raw.input_tokens) - usage.input_text_tokens - usage.input_audio_tokens);
    usage.output_text_tokens = n(outDetails.text_tokens);
    usage.output_audio_tokens = n(outDetails.audio_tokens);
    usage.output_other_tokens = Math.max(0, n(raw.output_tokens) - usage.output_text_tokens - usage.output_audio_tokens);
    usage.cached_tokens = n(inDetails.cached_tokens);
    usage.total_tokens = n(raw.total_tokens) || (n(raw.input_tokens) + n(raw.output_tokens));
    return usage;
}

module.exports = {
    SUM_FIELDS,
    emptyUsage,
    addUsage,
    hasGeminiUsage,
    normalizeGeminiUsage,
    normalizeRealtimeCompatUsage,
};

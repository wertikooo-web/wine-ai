'use strict';

const assert = require('assert');
const { buildRealtimeSystemInstruction, sanitizePromptConfig } = require('../src/realtime/realtimePrompt');
const { START_MARKER, buildVoiceSommelierStyleBlock } = require('../src/persona/voiceSommelierStyleModule');
const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');
const { GrokVoiceProvider } = require('../src/realtime/grokVoiceProvider');
const { ClassicVoiceProvider } = require('../src/realtime/classicVoiceProvider');

function countOccurrences(haystack, needle) {
    return haystack.split(needle).length - 1;
}

async function run() {
    console.log('Running Voice Sommelier Style -- assembly and all-engines wiring tests...');

    // --- Position and single-source assembly ------------------------------
    console.log('Testing: the module is assembled once, after the persona block, before per-turn context...');
    const prompt = buildRealtimeSystemInstruction({ persona: 'PERSONA_PLACEHOLDER_TEXT', currentContext: { mode: 'push_to_talk' } });
    assert.strictEqual(countOccurrences(prompt.text, START_MARKER), 1, 'the voice style block must appear exactly once, not duplicated');
    const personaIndex = prompt.text.indexOf('[PERSONA]');
    const styleIndex = prompt.text.indexOf(START_MARKER);
    const contextIndex = prompt.text.indexOf('[CURRENT CONTEXT]');
    assert.ok(personaIndex < styleIndex, 'the persona block (base safety + RAG policy) must come before the voice style module');
    assert.ok(styleIndex < contextIndex, 'the voice style module must come before per-turn current context');

    console.log('Testing: two independent prompt builds produce byte-identical voice style content (no drift)...');
    const promptA = buildRealtimeSystemInstruction({ persona: 'X', currentContext: {} });
    const promptB = buildRealtimeSystemInstruction({ persona: 'Y', currentContext: {} });
    assert.strictEqual(promptA.meta.voiceStyle.hash, promptB.meta.voiceStyle.hash, 'voice style content must be identical regardless of persona/context');
    assert.strictEqual(promptA.meta.voiceStyle.hash, buildVoiceSommelierStyleBlock().meta.hash, 'the prompt-embedded voice style must match the module\'s own standalone output -- proof of a single shared source, not a copy');

    // --- Survives a dashboard custom-persona override -----------------------
    console.log('Testing: a dashboard custom persona override still carries the voice style module in the final prompt...');
    const dashboardConfig = sanitizePromptConfig(
        { persona: 'CUSTOM ADMIN-WRITTEN PERSONA TEXT WITH NO MENTION OF WINE STYLE AT ALL.' },
        { allowCustomPrompt: true },
    );
    assert.strictEqual(dashboardConfig.source, 'dashboard');
    const dashboardPrompt = buildRealtimeSystemInstruction({ persona: dashboardConfig.blocks.persona, currentContext: { mode: 'push_to_talk' } });
    assert.strictEqual(countOccurrences(dashboardPrompt.text, START_MARKER), 1, 'a dashboard custom persona must still result in exactly one voice style block in the final prompt');
    assert.strictEqual(dashboardPrompt.meta.voiceStyle.hash, buildVoiceSommelierStyleBlock().meta.hash, 'the voice style content under a dashboard override must be unchanged from the standalone module output');
    assert.ok(dashboardPrompt.text.includes('CUSTOM ADMIN-WRITTEN PERSONA TEXT'), 'the custom persona text must still be present -- it augments, it does not get silently dropped either');

    // --- Reaches all three engines, identically -----------------------------
    console.log('Testing: Gemini Live, Grok Realtime, and the classic STT->LLM->TTS pipeline all receive the exact same voice style content...');
    const sharedPrompt = buildRealtimeSystemInstruction({ persona: 'SHARED_PERSONA', currentContext: { mode: 'push_to_talk' } });
    const sessionOptions = { systemInstructionText: sharedPrompt.text, systemInstructionMeta: sharedPrompt.meta, voiceName: 'test-voice' };

    const geminiProvider = new GeminiLiveProvider({ apiKey: 'test-key' });
    const geminiSession = geminiProvider.createSession(sessionOptions);
    try {
        assert.strictEqual(countOccurrences(geminiSession.systemInstructionText, START_MARKER), 1, 'Gemini Live session must receive the voice style block exactly once');
        assert.ok(geminiSession.systemInstructionText.includes('ОДНИМ словом'), 'Gemini Live session text must carry the short-answer rule');
    } finally {
        if (typeof geminiSession.destroy === 'function') geminiSession.destroy();
    }

    const grokProvider = new GrokVoiceProvider({ apiKey: 'test-key', webSocketFactory: () => ({ on() {}, once() {}, send() {}, close() {}, readyState: 0 }) });
    const grokSession = grokProvider.createSession(sessionOptions);
    try {
        assert.strictEqual(countOccurrences(grokSession.systemInstructionText, START_MARKER), 1, 'Grok Realtime session must receive the voice style block exactly once');
        assert.ok(grokSession.systemInstructionText.includes('ОДНИМ словом'), 'Grok Realtime session text must carry the short-answer rule');
    } finally {
        if (typeof grokSession.destroy === 'function') grokSession.destroy();
    }

    const classicProvider = new ClassicVoiceProvider({ sttProvider: 'whisper', openaiApiKey: 'test-key', geminiApiKey: 'test-key' });
    const classicSession = classicProvider.createSession(sessionOptions);
    try {
        assert.strictEqual(countOccurrences(classicSession.systemInstructionText, START_MARKER), 1, 'Classic STT->LLM->TTS session must receive the voice style block exactly once');
        assert.ok(classicSession.systemInstructionText.includes('ОДНИМ словом'), 'Classic session text must carry the short-answer rule');
    } finally {
        if (typeof classicSession.destroy === 'function') classicSession.destroy();
    }

    assert.strictEqual(geminiSession.systemInstructionText, grokSession.systemInstructionText, 'Gemini and Grok sessions must receive byte-identical instructions -- proof of one shared assembly point, not per-provider copies');
    assert.strictEqual(geminiSession.systemInstructionText, classicSession.systemInstructionText, 'Gemini and Classic sessions must receive byte-identical instructions -- proof of one shared assembly point, not per-provider copies');

    console.log('ALL VOICE SOMMELIER STYLE ALL-ENGINES TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error('Voice Sommelier Style all-engines tests failed:', error);
        process.exit(1);
    });
}

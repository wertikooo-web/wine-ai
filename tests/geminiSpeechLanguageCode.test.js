'use strict';

// (г) Accent drift experiment: GEMINI_SPEECH_LANGUAGE_CODE adds
// speechConfig.languageCode; off by default so the live voice config is
// byte-for-byte unchanged unless the operator sets it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiSpeechConfig } = require('../src/realtime/geminiLiveProvider');
const { classifyRoute } = require('../src/security/adminAuth');

test('no env: speech config unchanged (no languageCode)', () => {
    delete process.env.GEMINI_SPEECH_LANGUAGE_CODE;
    const config = buildGeminiSpeechConfig('Leda');
    assert.deepEqual(config, { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } } });
});

test('env set: languageCode added; invalid values ignored', () => {
    process.env.GEMINI_SPEECH_LANGUAGE_CODE = 'ru-RU';
    assert.equal(buildGeminiSpeechConfig('Leda').languageCode, 'ru-RU');
    process.env.GEMINI_SPEECH_LANGUAGE_CODE = 'ru_RU; drop';
    assert.equal(buildGeminiSpeechConfig('Leda').languageCode, undefined);
    delete process.env.GEMINI_SPEECH_LANGUAGE_CODE;
});

test('the language-code probe endpoint is admin-only', () => {
    assert.equal(classifyRoute('POST', '/api/diag/gemini-language-code'), 'admin');
});

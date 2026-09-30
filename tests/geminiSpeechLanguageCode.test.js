'use strict';

// (г) Accent drift experiment: GEMINI_SPEECH_LANGUAGE_CODE adds
// speechConfig.languageCode ONLY for conversations in that language
// (ru-RU -> Russian only); off by default so the live voice config is
// byte-for-byte unchanged unless the operator sets it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGeminiSpeechConfig, speechLanguageCode } = require('../src/realtime/geminiLiveProvider');
const { classifyRoute } = require('../src/security/adminAuth');

test('no env: speech config unchanged (no languageCode)', () => {
    delete process.env.GEMINI_SPEECH_LANGUAGE_CODE;
    const config = buildGeminiSpeechConfig('Leda');
    assert.deepEqual(config, { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Leda' } } });
});

test('ru-RU applies only to Russian conversations', () => {
    process.env.GEMINI_SPEECH_LANGUAGE_CODE = 'ru-RU';
    assert.equal(buildGeminiSpeechConfig('Leda', 'ru').languageCode, 'ru-RU', 'Russian conversation: anchored');
    assert.equal(buildGeminiSpeechConfig('Leda', 'ro').languageCode, undefined, 'Romanian guest: unchanged');
    assert.equal(buildGeminiSpeechConfig('Leda', 'en').languageCode, undefined, 'English guest: unchanged');
    assert.equal(buildGeminiSpeechConfig('Leda', null).languageCode, undefined, 'unknown language: unchanged');
    assert.equal(buildGeminiSpeechConfig('Leda').languageCode, undefined, 'no language passed: unchanged');
    delete process.env.GEMINI_SPEECH_LANGUAGE_CODE;
});

test('several codes: each only for its own language; invalid values ignored', () => {
    process.env.GEMINI_SPEECH_LANGUAGE_CODE = 'ru-RU, ro-RO';
    assert.equal(speechLanguageCode('ru'), 'ru-RU');
    assert.equal(speechLanguageCode('ro'), 'ro-RO');
    assert.equal(speechLanguageCode('en'), null);
    process.env.GEMINI_SPEECH_LANGUAGE_CODE = 'ru_RU; drop';
    assert.equal(buildGeminiSpeechConfig('Leda', 'ru').languageCode, undefined);
    delete process.env.GEMINI_SPEECH_LANGUAGE_CODE;
});

test('realtime server passes the conversation language to the provider session', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'realtime', 'realtimeServer.js'), 'utf8');
    assert.ok(/sessionLanguage: sessionLanguage \|\| null,/.test(src));
    const provider = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'realtime', 'geminiLiveProvider.js'), 'utf8');
    assert.ok(/buildGeminiSpeechConfig\(this\.voiceName, this\.sessionLanguage\)/.test(provider));
});

test('the language-code probe endpoint is admin-only', () => {
    assert.equal(classifyRoute('POST', '/api/diag/gemini-language-code'), 'admin');
});

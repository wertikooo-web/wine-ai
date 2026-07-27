'use strict';

// Regression coverage for "provider not ready" recurring every turn, not
// just on the first one: production logs showed provider_session_rotated
// reason=output_generation_complete firing after every single Hold to Talk
// reply, tearing down and reconnecting the Gemini Live session between
// every utterance. See src/realtime/geminiLiveProvider.js's
// rotateAfterOutputComplete and src/realtime/realtimeServer.js's
// shouldRotateProviderAfterOutputComplete(), which reads it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiLiveProvider } = require('../src/realtime/geminiLiveProvider');
const { GrokVoiceProvider } = require('../src/realtime/grokVoiceProvider');

test('Gemini Hold to Talk no longer rotates the provider connection after every output', () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'hold_to_talk', rotationMode: 'per_turn' });

    assert.equal(session.rotateAfterOutputComplete, false, 'the connection must persist across turns, not reconnect after every reply');
    // Interrupt-triggered rotation is a separate, unaffected concern — this
    // fix only removes the per-turn output-complete rotation.
    assert.equal(session.rotateOnInterrupt, true, 'interrupt-triggered rotation for Hold to Talk must be untouched by this fix');
});

test('Gemini Tap to Start still never rotates after output (no regression)', () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'tap_to_start', rotationMode: 'per_turn' });

    assert.equal(session.rotateAfterOutputComplete, false);
    assert.equal(session.rotateOnInterrupt, false, 'Tap to Start never rotated on interrupt either, before or after this fix');
});

test('Gemini Hold to Talk with rotationMode errors_only also never rotates after output (no regression)', () => {
    const provider = new GeminiLiveProvider({ apiKey: 'fake-key' });
    const session = provider.createSession({ voiceMode: 'hold_to_talk', rotationMode: 'errors_only' });

    assert.equal(session.rotateAfterOutputComplete, false);
});

test('Grok never rotated after output in any voice mode (no regression, unaffected by this fix)', () => {
    const provider = new GrokVoiceProvider({ apiKey: 'fake-key' });
    const holdSession = provider.createSession({ voiceMode: 'hold_to_talk' });
    const tapSession = provider.createSession({ voiceMode: 'tap_to_start' });

    assert.equal(holdSession.rotateAfterOutputComplete, false);
    assert.equal(tapSession.rotateAfterOutputComplete, false);
});

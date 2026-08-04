'use strict';

// Server-side settings for Free Conversation's session-duration cap:
// operator-configurable minutes (2.5/3/5/10 preset list), per-deployment-
// context overrides (kiosk / mobile_qr), and the server routes that expose
// them. Uses a fresh personaStore module instance per test (file-fallback
// mode -- no Postgres in this sandbox, matching how personaStore already
// falls back when db.isEnabled() is false).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshPersonaStore(overridesFilePath) {
    process.env.PERSONA_OVERRIDES_FILE = overridesFilePath;
    delete require.cache[require.resolve('../src/persona/personaStore')];
    delete require.cache[require.resolve('../src/knowledge/db')];
    return require('../src/persona/personaStore');
}

async function run() {
    console.log('Running Session Limit Settings Tests...');

    const tmpFile = path.join(os.tmpdir(), `persona-overrides-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

    try {
        const personaStore = freshPersonaStore(tmpFile);
        await personaStore.load();

        console.log('Testing default session limit is 3 minutes...');
        assert.strictEqual(personaStore.getSessionLimitMinutes(null), 3, 'default must be 3 minutes');
        assert.strictEqual(personaStore.getSessionLimitMinutes('kiosk'), 3, 'kiosk falls back to the general default when no override is set');
        assert.strictEqual(personaStore.getSessionLimitMinutes('mobile_qr'), 3, 'mobile_qr falls back to the general default when no override is set');

        console.log('Testing only the allowed preset values (2.5/3/5/10) are accepted...');
        await assert.rejects(() => personaStore.setSessionLimitMinutes(4), /invalid_session_limit_minutes/, 'a non-preset value must be rejected');
        await assert.rejects(() => personaStore.setSessionLimitMinutes(0), /invalid_session_limit_minutes/, 'zero must be rejected (no infinite-free-extension footgun)');
        await assert.rejects(() => personaStore.setSessionLimitMinutes(-5), /invalid_session_limit_minutes/, 'a negative value must be rejected');
        for (const minutes of [2.5, 3, 5, 10]) {
            const result = await personaStore.setSessionLimitMinutes(minutes);
            assert.strictEqual(result.sessionLimitMinutes, minutes, `${minutes} must be accepted and reflected immediately`);
        }

        console.log('Testing the general limit persists across a fresh load() (file-backed)...');
        await personaStore.setSessionLimitMinutes(5);
        const reloaded = freshPersonaStore(tmpFile);
        await reloaded.load();
        assert.strictEqual(reloaded.getSessionLimitMinutes(null), 5, 'the saved value must survive a reload from disk');

        console.log('Testing per-context overrides (kiosk / mobile_qr)...');
        const store2 = freshPersonaStore(tmpFile);
        await store2.load();
        await store2.setSessionLimitMinutes(3);
        await store2.setSessionLimitMinutesForContext('kiosk', 10);
        assert.strictEqual(store2.getSessionLimitMinutes('kiosk'), 10, 'kiosk must use its own override');
        assert.strictEqual(store2.getSessionLimitMinutes('mobile_qr'), 3, 'mobile_qr must still fall back to the general default (no cross-context leak)');
        assert.strictEqual(store2.getSessionLimitMinutes(null), 3, 'the general default is unaffected by the kiosk override');

        await store2.setSessionLimitMinutesForContext('mobile_qr', 2.5);
        assert.strictEqual(store2.getSessionLimitMinutes('mobile_qr'), 2.5, 'mobile_qr must now use its own override');
        assert.strictEqual(store2.getSessionLimitMinutes('kiosk'), 10, 'setting mobile_qr must not disturb the separately-set kiosk override');

        console.log('Testing clearing a context override (null) falls back to the general default...');
        await store2.setSessionLimitMinutesForContext('kiosk', null);
        assert.strictEqual(store2.getSessionLimitMinutes('kiosk'), 3, 'clearing the override must fall back to the general default');

        console.log('Testing an invalid context is rejected...');
        await assert.rejects(() => store2.setSessionLimitMinutesForContext('desktop', 5), /invalid_session_limit_context/, 'an unrecognized context must be rejected');

        console.log('Testing an unrecognized context passed to the getter is safe (falls back, never throws)...');
        assert.strictEqual(store2.getSessionLimitMinutes('some_unknown_context'), 3, 'an unknown context must fall back to the general default without throwing');
        assert.strictEqual(store2.getSessionLimitMinutes(undefined), 3, 'no context must fall back to the general default');

        console.log('ALL SESSION LIMIT SETTINGS TESTS PASSED!');
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
        try { fs.unlinkSync(tmpFile + '.tmp'); } catch { /* never existed */ }
        delete process.env.PERSONA_OVERRIDES_FILE;
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch((err) => {
        console.error('Session limit settings tests failed:', err);
        process.exit(1);
    });
}

module.exports = { run };

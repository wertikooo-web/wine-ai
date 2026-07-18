'use strict';

const { AvatarProvider } = require('../src/avatar/AvatarProvider');
const { MockAvatarProvider } = require('../src/avatar/providers/mockAvatarProvider');
const t = require('./helpers/assertions');

async function run() {
    // Stage 13's "тест отсутствующего avatar provider": the base interface
    // must fail loudly and specifically for every method when a concrete
    // provider hasn't implemented it — never silently no-op.
    const base = new AvatarProvider();
    for (const method of ['connect', 'startSpeaking', 'stopSpeaking', 'disconnect']) {
        let threw = false;
        try {
            await base[method]();
        } catch (error) {
            threw = true;
            t.match(error.message, /not implemented/);
        }
        t.ok(threw, `AvatarProvider.${method}() must throw when not implemented by a subclass`);
    }
    t.ok((() => { try { base.setLanguage('ru'); return false; } catch { return true; } })(), 'setLanguage() must throw when not implemented');
    t.ok((() => { try { base.getStatus(); return false; } catch { return true; } })(), 'getStatus() must throw when not implemented');

    // Mock provider: full lifecycle.
    const mock = new MockAvatarProvider();
    t.deepEqual(mock.getStatus(), { provider: 'mock', connected: false, speaking: false, language: null });

    await mock.connect();
    t.equal(mock.getStatus().connected, true);

    mock.setLanguage('ro');
    t.equal(mock.getStatus().language, 'ro');

    await mock.startSpeaking(null);
    t.equal(mock.getStatus().speaking, true);

    await mock.stopSpeaking();
    t.equal(mock.getStatus().speaking, false);

    await mock.disconnect();
    t.equal(mock.getStatus().connected, false);

    // startSpeaking before connect() must fail rather than silently "work".
    const fresh = new MockAvatarProvider();
    let threwBeforeConnect = false;
    try {
        await fresh.startSpeaking(null);
    } catch {
        threwBeforeConnect = true;
    }
    t.ok(threwBeforeConnect, 'startSpeaking() before connect() must throw');
}

module.exports = { run };

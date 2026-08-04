'use strict';

// End-to-end (real HTTP server, real routes) coverage for the session-limit
// settings API and the session-end analytics endpoint -- complements
// tests/sessionLimitSettings.test.js (personaStore unit-level) and
// tests/dashboardBargeIn.test.js (client-side timer/state-machine logic).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_HTTP_PORT || 8795);
const BASE = `http://localhost:${PORT}`;

function waitForHealth(deadline) {
    return fetch(`${BASE}/health`).then((res) => {
        if (!res.ok) throw new Error(`/health returned ${res.status}`);
        return res.json();
    }, () => {
        if (Date.now() > deadline) throw new Error('server did not become healthy in time');
        return new Promise((r) => setTimeout(r, 150)).then(() => waitForHealth(deadline));
    });
}

async function run() {
    console.log('Running Session Limit API Tests...');

    const tmpFile = path.join(os.tmpdir(), `persona-overrides-api-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), REALTIME_PROVIDER: 'mock', PERSONA_OVERRIDES_FILE: tmpFile },
        stdio: 'pipe',
    });
    let serverOutput = '';
    child.stdout.on('data', (d) => { serverOutput += d; });
    child.stderr.on('data', (d) => { serverOutput += d; });

    try {
        await waitForHealth(Date.now() + 5000);

        console.log('Testing GET /api/persona exposes the allowed preset list and current value...');
        {
            const res = await fetch(`${BASE}/api/persona`);
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(data.allowedSessionLimitMinutes, [2.5, 3, 5, 10], 'the exact preset list must be exposed, not invented client-side');
            assert.strictEqual(data.sessionLimitMinutes, 3, 'default is 3 minutes');
            assert.strictEqual(data.freeConversationSessionLimitMs, 3 * 60 * 1000, 'the ms value the realtime client actually uses must match');
            assert.deepStrictEqual(data.sessionLimitMinutesByContext, { kiosk: null, mobile_qr: null }, 'no per-context overrides set yet');
        }

        console.log('Testing POST /api/persona sets the general session limit and it is immediately reflected...');
        {
            const res = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profileId: 'classic', sessionLimitMinutes: 5 }),
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(data)}`);
            assert.strictEqual(data.sessionLimitMinutes, 5);
            assert.strictEqual(data.freeConversationSessionLimitMs, 5 * 60 * 1000);
        }

        console.log('Testing POST /api/persona rejects a non-preset session limit value...');
        {
            const res = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profileId: 'classic', sessionLimitMinutes: 7 }),
            });
            assert.strictEqual(res.status, 400, 'a non-preset value must be rejected with 400, not silently accepted');
        }

        console.log('Testing per-context overrides via POST, then GET with ?context= resolves them...');
        {
            const postRes = await fetch(`${BASE}/api/persona`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profileId: 'classic', sessionLimitMinutesByContext: { kiosk: 10, mobile_qr: 2.5 } }),
            });
            const postData = await postRes.json();
            assert.strictEqual(postRes.status, 200, JSON.stringify(postData));

            const kioskRes = await fetch(`${BASE}/api/persona?context=kiosk`);
            const kioskData = await kioskRes.json();
            assert.strictEqual(kioskData.freeConversationSessionLimitMs, 10 * 60 * 1000, 'a kiosk-context request must get the kiosk override, not the general default');

            const mobileRes = await fetch(`${BASE}/api/persona?context=mobile_qr`);
            const mobileData = await mobileRes.json();
            assert.strictEqual(mobileData.freeConversationSessionLimitMs, 2.5 * 60 * 1000, 'a mobile_qr-context request must get the mobile_qr override');

            const generalRes = await fetch(`${BASE}/api/persona`);
            const generalData = await generalRes.json();
            assert.strictEqual(generalData.freeConversationSessionLimitMs, 5 * 60 * 1000, 'a request with no context must still get the general default, unaffected by the per-context overrides');
        }

        console.log('Testing POST /api/analytics/session-end accepts each documented reason...');
        {
            for (const reason of ['session_timeout', 'inactivity_timeout', 'user_disconnect', 'technical_error']) {
                const res = await fetch(`${BASE}/api/analytics/session-end`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason, sessionId: 'test-session', voiceMode: 'tap_to_start', context: 'kiosk', durationMs: 12345 }),
                });
                const data = await res.json();
                assert.strictEqual(res.status, 200, `reason "${reason}" must be accepted`);
                assert.strictEqual(data.ok, true);
            }
        }

        assert.ok(!serverOutput.includes('Cannot find module'), 'server output must not contain "Cannot find module"');

        console.log('ALL SESSION LIMIT API TESTS PASSED!');
    } finally {
        await new Promise((r) => setTimeout(r, 200));
        try { child.kill(); } catch { /* already gone */ }
        try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
        try { fs.unlinkSync(tmpFile + '.tmp'); } catch { /* never existed */ }
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch((err) => {
        console.error('Session limit API tests failed:', err);
        process.exit(1);
    });
}

module.exports = { run };

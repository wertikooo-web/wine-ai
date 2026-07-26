'use strict';

// Regression: commit b8b8748 required src/auth/adminAuth.js which was never
// committed. The repair commit removed that dead import. This test proves
// the server starts without the module, /health and /api/persona respond,
// and the dashboard is served — without relying on any dirty-tree files.

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.SMOKE_HTTP_PORT || 8793);
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
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), REALTIME_PROVIDER: 'mock' },
        stdio: 'pipe',
    });
    let serverOutput = '';
    child.stdout.on('data', (d) => { serverOutput += d; });
    child.stderr.on('data', (d) => { serverOutput += d; });

    let failed = 0;

    try {
        const health = await waitForHealth(Date.now() + 5000);
        assert.strictEqual(health.ok, true, '/health should return ok:true');
        console.log('ok  /health responded 200');

        // Module load — if adminAuth was still required, server would have
        // crashed with MODULE_NOT_FOUND before reaching this point.
        assert.ok(
            !serverOutput.includes('Cannot find module'),
            'server output must not contain "Cannot find module"'
        );
        console.log('ok  no MODULE_NOT_FOUND in server output');

        // No ADMIN_PASSWORD required at startup
        assert.ok(
            !serverOutput.includes('ADMIN_PASSWORD'),
            'server should not require ADMIN_PASSWORD env var at startup'
        );
        console.log('ok  no ADMIN_PASSWORD startup requirement');

        // /api/persona responds
        const personaRes = await fetch(`${BASE}/api/persona`);
        assert.ok(personaRes.ok, `/api/persona should respond 200, got ${personaRes.status}`);
        const personaData = await personaRes.json();
        assert.strictEqual(personaData.ok, true, '/api/persona ok:true');
        console.log('ok  /api/persona responded 200');

        // Dashboard is served
        const dashRes = await fetch(`${BASE}/dashboard`);
        assert.ok(dashRes.ok, `/dashboard should respond 200, got ${dashRes.status}`);
        console.log('ok  /dashboard responded 200');

    } catch (error) {
        console.error('FAIL', error.message);
        failed = 1;
    } finally {
        try { child.kill(); } catch { /* already gone */ }
    }

    console.log(failed === 0
        ? '\nstartupNoAdminAuth passed'
        : `\nstartupNoAdminAuth FAILED (${failed} check(s) failed)`
    );
    process.exit(failed);
}

module.exports = { run };

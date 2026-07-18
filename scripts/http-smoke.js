'use strict';

// Spawns the real server as a separate process (not in-process require) and
// hits every documented HTTP endpoint — a genuine black-box smoke test,
// distinct from the in-process unit tests under tests/.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.SMOKE_HTTP_PORT || 8791);
const BASE = `http://localhost:${PORT}`;
const ENDPOINTS = [
    ['/health', 200],
    ['/', 200],
    ['/dashboard', 200],
    ['/api/voices', 200],
    ['/api/persona', 200],
    ['/api/knowledge/status', 200],
    ['/api/knowledge/sources', 200],
    ['/api/avatar/status', 200],
    ['/nonexistent', 404],
];

function waitForHealth(deadline) {
    return fetch(`${BASE}/health`).then((res) => res.ok, () => {
        if (Date.now() > deadline) throw new Error('server did not become healthy in time');
        return new Promise((resolve) => setTimeout(resolve, 150)).then(() => waitForHealth(deadline));
    });
}

async function main() {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), REALTIME_PROVIDER: 'mock' },
        stdio: 'pipe',
    });
    let exitCode = 0;

    try {
        await waitForHealth(Date.now() + 5000);
        for (const [route, expectedStatus] of ENDPOINTS) {
            const res = await fetch(`${BASE}${route}`);
            const ok = res.status === expectedStatus;
            console.log(`${ok ? 'ok  ' : 'FAIL'} ${route} -> ${res.status} (expected ${expectedStatus})`);
            if (!ok) exitCode = 1;
        }
    } catch (error) {
        console.error('FAIL', error.message);
        exitCode = 1;
    } finally {
        // Best-effort kill — this sandbox's networking teardown can raise a
        // native libuv assertion in the child right as its sockets close
        // (see docs/WINE_AI_MIGRATION_PLAN.md-adjacent note in
        // tests/helpers/testServer.js for the same underlying issue found
        // during test-suite work). It's a child-process artifact, not a
        // real endpoint failure — swallow it rather than let it flip
        // exitCode after every check already passed.
        try { child.kill(); } catch { /* already gone */ }
    }

    setTimeout(() => process.exit(exitCode), 150);
}

main();

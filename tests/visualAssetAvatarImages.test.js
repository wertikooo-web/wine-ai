'use strict';

// Regression: production images for both avatars (the main dashboard's
// #avatarBox fallback and the persona-select cards' Александр/Мария photos)
// disappeared after a deploy. Two independent causes, both covered here:
//   1. /visual-assets/avatar-man-1.png had NO server route at all (a plain
//      code bug -- server.js's visualStaticFiles table never had an entry
//      for it, even though dashboard.html has always referenced it).
//   2. `railway up` (the CLI deploy path) excludes any path matching
//      .gitignore by default -- including *.png files that are actually
//      git-tracked (force-added) and required in production. That part of
//      the incident was a deploy-process fix (`railway up --no-gitignore`),
//      not something a Node test can catch, but this file guards the code
//      side: every avatar path dashboard.html references must have a
//      working server route to a file that actually exists on disk.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_HTTP_PORT || 8794);
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
    console.log('Running Visual Asset Avatar Image Tests...');

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), REALTIME_PROVIDER: 'mock' },
        stdio: 'pipe',
    });
    let serverOutput = '';
    child.stdout.on('data', (d) => { serverOutput += d; });
    child.stderr.on('data', (d) => { serverOutput += d; });

    try {
        await waitForHealth(Date.now() + 5000);

        // Every avatar path dashboard.html actually references -- if a new
        // one is added there without a matching server route, this list
        // must be updated too (belt-and-suspenders with the dashboard-html
        // cross-check below).
        const avatarPaths = ['/visual-assets/avatar-woman-1.png', '/visual-assets/avatar-man-1.png'];

        for (const assetPath of avatarPaths) {
            const res = await fetch(`${BASE}${assetPath}`);
            assert.strictEqual(res.status, 200, `${assetPath} must respond 200 (not the browser's broken-image fallback)`);
            const contentType = res.headers.get('content-type') || '';
            assert.ok(contentType.startsWith('image/'), `${assetPath} must have an image/* content-type, got "${contentType}"`);
            const buffer = Buffer.from(await res.arrayBuffer());
            assert.ok(buffer.length > 0, `${assetPath} must return a non-empty body`);
            // A 404/error page served with a 200 status would still be
            // "successful" by the checks above -- catch that specific
            // failure mode by asserting the body isn't actually HTML.
            const head = buffer.subarray(0, 15).toString('utf8').trim().toLowerCase();
            assert.ok(!head.startsWith('<!doctype') && !head.startsWith('<html'), `${assetPath} must not return an HTML page instead of image bytes`);
            console.log(`ok  ${assetPath} -> 200 ${contentType} (${buffer.length} bytes)`);
        }

        // Cross-check against the actual markup: every /visual-assets/avatar-*
        // path dashboard.html references must be one of the paths just
        // verified above -- if a new avatar image reference is added to the
        // HTML without a corresponding route, this fails loudly instead of
        // silently 404ing in production.
        const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
        const referenced = new Set();
        for (const match of dashboardHtml.matchAll(/\/visual-assets\/avatar-[\w.-]+\.png/g)) {
            referenced.add(match[0]);
        }
        assert.ok(referenced.size > 0, 'sanity: dashboard.html must reference at least one avatar image path');
        for (const refPath of referenced) {
            assert.ok(
                avatarPaths.includes(refPath),
                `dashboard.html references ${refPath}, which is not covered by this test's known/verified avatar paths -- add a server route and cover it here`
            );
        }
        console.log(`ok  every avatar path referenced by dashboard.html (${[...referenced].join(', ')}) was verified above`);

        assert.ok(!serverOutput.includes('Cannot find module'), 'server output must not contain "Cannot find module"');

        console.log('ALL VISUAL ASSET AVATAR IMAGE TESTS PASSED!');
    } finally {
        // A brief pause before kill() avoids a Windows-only libuv assertion
        // crash (uv_async close-while-pending, src/win/async.c) seen when
        // killing a child process that still has in-flight stdio reads --
        // this file's real multi-megabyte image fetches leave more pending
        // I/O at teardown time than startupNoAdminAuth.test.js's much
        // shorter-lived child, which is what actually triggers the race.
        await new Promise((r) => setTimeout(r, 200));
        try { child.kill(); } catch { /* already gone */ }
    }
}

if (require.main === module) {
    run().then(() => process.exit(0)).catch((err) => {
        console.error('Visual asset avatar image tests failed:', err);
        process.exit(1);
    });
}

module.exports = { run };

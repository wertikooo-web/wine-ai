'use strict';

// Knowledge Studio admin API (Phase 5) — HTTP-surface test.
//
// Spawns the real server in file-backed mode (no Postgres) and verifies the
// /api/studio/* contract that /knowledge-studio drives:
//   - predicates/entity-types vocabulary is served for the editor UI;
//   - entity search works against the real canonical registry file
//     (knowledge/entity-aliases.json) without a database;
//   - mutation endpoints are guarded when Postgres is unavailable (503
//     DATABASE_REQUIRED), so a local/file-backed box never silently drops an
//     editor's change;
//   - unknown routes 404.
//
// Postgres-backed mutation behaviour is covered at store level
// (tests/studioStore.test.js) and through the production read path
// (tests/studioCanonicalWorkflow.test.js).

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function waitForPort(child) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server did not report its port')), 15000);
        const inspect = (data) => {
            const match = String(data).match(/listening port=(\d+)/i);
            if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
        };
        child.stdout.on('data', inspect);
        child.stderr.on('data', inspect);
        child.once('exit', (code) => reject(new Error(`server exited before test: ${code}`)));
    });
}

async function run() {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: '0', REALTIME_PROVIDER: 'mock', DATABASE_URL: '', GEMINI_API_KEY: '', AUDIT_STORE_FORCE_FILE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const port = await waitForPort(child);
        const base = `http://127.0.0.1:${port}`;

        // Admin page is served.
        const page = await fetch(`${base}/knowledge-studio`);
        assert.strictEqual(page.status, 200, 'knowledge-studio page must be served');
        const html = await page.text();
        assert.ok(html.includes('Knowledge Studio'), 'page must render the studio title');

        // Editor vocabulary is available without a database.
        const predicates = await fetch(`${base}/api/studio/predicates`);
        assert.strictEqual(predicates.status, 200);
        const predBody = await predicates.json();
        assert.strictEqual(predBody.ok, true);
        assert.ok(Array.isArray(predBody.predicates) && predBody.predicates.length > 0, 'relation vocabulary must be served');
        assert.ok(Array.isArray(predBody.entity_types) && predBody.entity_types.length > 0, 'entity types must be served');
        assert.strictEqual(predBody.database_enabled, false, 'file-backed mode must report database_enabled=false');

        // Entity search reads the real canonical registry file.
        const search = await fetch(`${base}/api/studio/entities?q=purcari`);
        assert.strictEqual(search.status, 200);
        const searchBody = await search.json();
        assert.strictEqual(searchBody.ok, true);
        assert.ok(Array.isArray(searchBody.entities), 'entities must be an array');
        assert.ok(searchBody.entities.some((e) => e.entityId === 'purcari'), 'registry search must find purcari');

        // Review queues degrade gracefully without a database (enabled:false).
        const queues = await fetch(`${base}/api/studio/queues`);
        assert.strictEqual(queues.status, 200);
        const queuesBody = await queues.json();
        assert.strictEqual(queuesBody.ok, true);
        assert.strictEqual(queuesBody.enabled, false, 'queues must report disabled without a database');

        // Mutations are refused (not silently ignored) without Postgres.
        const mutation = await fetch(`${base}/api/studio/facts`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entityId: 'purcari', fieldName: 'x', value: 'y' }),
        });
        assert.strictEqual(mutation.status, 503, 'fact mutation must be refused without Postgres');
        const mutationBody = await mutation.json();
        assert.strictEqual(mutationBody.error, 'DATABASE_REQUIRED', 'mutation must report DATABASE_REQUIRED');

        // Unknown studio route 404s.
        const missing = await fetch(`${base}/api/studio/nope`);
        assert.strictEqual(missing.status, 404);

        console.log('studioApi passed (8 assertions)');
        return { assertionCount: 8 };
    } finally {
        child.kill();
    }
}

module.exports = { run };
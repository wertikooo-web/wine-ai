'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

function waitForPort(child) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('server did not report its port')), 10000);
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
        env: { ...process.env, PORT: '0', REALTIME_PROVIDER: 'mock', DATABASE_URL: '', GEMINI_API_KEY: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const port = await waitForPort(child);
        const invalid = await fetch(`http://127.0.0.1:${port}/api/knowledge/evaluate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }),
        });
        assert.strictEqual(invalid.status, 400, 'empty question must be rejected before model usage');
        assert.strictEqual((await invalid.json()).error, 'question_required');

        const unavailable = await fetch(`http://127.0.0.1:${port}/api/knowledge/evaluate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Расскажи про Fetească Neagră', language: 'ru' }),
        });
        assert.strictEqual(unavailable.status, 503, 'missing text-model key must be explicit and must not silently answer');
        assert.strictEqual((await unavailable.json()).error, 'text_evaluation_unavailable');
        console.log('textKnowledgeEvaluationApi passed (4 assertions)');
        return { assertionCount: 4 };
    } finally {
        child.kill();
    }
}

module.exports = { run };

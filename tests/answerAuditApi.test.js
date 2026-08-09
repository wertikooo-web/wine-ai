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
        env: { ...process.env, PORT: '0', REALTIME_PROVIDER: 'mock', DATABASE_URL: '', GEMINI_API_KEY: '', AUDIT_STORE_FORCE_FILE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        const port = await waitForPort(child);
        const base = `http://127.0.0.1:${port}`;

        // Empty question → 400 before any orchestration.
        const empty = await fetch(`${base}/api/knowledge/audit`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }),
        });
        assert.strictEqual(empty.status, 400, 'empty question must be rejected');
        assert.strictEqual((await empty.json()).error, 'question_required');

        // Invalid review status → 400 with the allowed vocabulary.
        const badStatus = await fetch(`${base}/api/knowledge/audit/cases/audit_abc`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'nope' }),
        });
        assert.strictEqual(badStatus.status, 400, 'invalid review status must be rejected');

        // A single-mode run, save disabled: no case persisted, results have metrics.
        const audit = await fetch(`${base}/api/knowledge/audit`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'Расскажи про Fetească Neagră', language: 'ru', modes: ['knowledge_only'], save: false }),
        });
        assert.strictEqual(audit.status, 200, 'single-mode audit must succeed without text-model keys');
        const auditBody = await audit.json();
        assert.strictEqual(auditBody.ok, true);
        assert.strictEqual(auditBody.saved, false);
        assert.ok(auditBody.audit.id.startsWith('audit_'));
        assert.strictEqual(auditBody.audit.modes[0], 'knowledge_only');
        assert.strictEqual(auditBody.audit.results.length, 1);
        assert.ok(auditBody.audit.results[0].metrics, 'mode result must carry audit metrics');
        assert.strictEqual(typeof auditBody.audit.results[0].metrics.hallucination, 'object');
        assert.strictEqual(typeof auditBody.audit.results[0].metrics.provenance_coverage, 'object');

        // save=true persists a case into the file backend → review round-trip works.
        const saved = await fetch(`${base}/api/knowledge/audit`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: 'Что такое Cricova?', modes: ['knowledge_catalog'] }),
        });
        assert.strictEqual(saved.status, 200);
        const savedBody = await saved.json();
        assert.strictEqual(savedBody.ok, true);
        assert.strictEqual(savedBody.case.saved, true);
        const caseId = savedBody.case.id;

        const found = await fetch(`${base}/api/knowledge/audit/cases/${caseId}`);
        assert.strictEqual(found.status, 200);
        const foundBody = await found.json();
        assert.strictEqual(foundBody.case.review_status, 'new');

        const reviewed = await fetch(`${base}/api/knowledge/audit/cases/${caseId}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'ok', comment: 'clean, provenance solid' }),
        });
        assert.strictEqual(reviewed.status, 200);
        const reviewedBody = await reviewed.json();
        assert.strictEqual(reviewedBody.case.review_status, 'ok');
        assert.strictEqual(reviewedBody.case.review_comment, 'clean, provenance solid');

        const missingCase = await fetch(`${base}/api/knowledge/audit/cases/audit_nope`);
        assert.strictEqual(missingCase.status, 404, 'missing case must 404');

        const list = await fetch(`${base}/api/knowledge/audit/cases`);
        assert.strictEqual(list.status, 200);
        const listBody = await list.json();
        assert.ok(Array.isArray(listBody.cases));
        assert.ok(listBody.cases.some((c) => c.id === caseId), 'saved case must appear in the case list');

        console.log('answerAuditApi passed (8 assertions)');
        return { assertionCount: 8 };
    } finally {
        child.kill();
    }
}

module.exports = { run };
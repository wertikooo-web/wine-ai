'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../src/knowledge/auditStore');

const AUDIT_DIR = path.resolve(__dirname, '..', 'knowledge', 'audit');

function makeRecord(id) {
    return {
        id,
        created_at: new Date().toISOString(),
        question: 'Сколько стоит Purcari?',
        language: 'ru',
        answer_mode: 'all',
        modes: ['knowledge_only', 'knowledge_catalog', 'knowledge_web', 'expert'],
        constraints: [],
        results: [{ answer_mode: 'knowledge_only', latency_ms: 12.3, answerable: true, claims: [] }],
        latency_ms_total: 45.6,
        notes: null,
    };
}

async function run() {
    process.env.AUDIT_STORE_FORCE_FILE = '1';
    if (fs.existsSync(AUDIT_DIR)) {
        for (const file of fs.readdirSync(AUDIT_DIR)) {
            if (file.endsWith('.json') && file.includes('testcase-audit')) {
                fs.unlinkSync(path.join(AUDIT_DIR, file));
            }
        }
    }

    const record = makeRecord('testcase-audit-store-1');
    const saved = await store.save(record);
    assert.strictEqual(saved.id, record.id);

    const found = await store.findById(record.id);
    assert.ok(found, 'case must be retrievable by id');
    assert.strictEqual(found.question, record.question);
    assert.strictEqual(found.answer_mode, 'all');
    assert.deepStrictEqual(found.modes, record.modes);
    assert.strictEqual(found.review_status, 'new');

    const missing = await store.findById('testcase-audit-store-missing');
    assert.strictEqual(missing, null);

    const listed = await store.listCases({ limit: 10 });
    assert.ok(listed.some((c) => c.id === record.id));

    // setReview with a valid status persists the verdict + comment.
    const reviewed = await store.setReview(record.id, { status: 'ok', comment: 'clean, provenance solid' });
    assert.strictEqual(reviewed.review_status, 'ok');
    assert.strictEqual(reviewed.review_comment, 'clean, provenance solid');
    assert.ok(reviewed.reviewed_at);

    const afterReview = await store.findById(record.id);
    assert.strictEqual(afterReview.review_status, 'ok');
    assert.strictEqual(afterReview.review_comment, 'clean, provenance solid');

    // Invalid status resets to 'new'; unknown id returns null.
    const invalidReview = await store.setReview(record.id, { status: 'bogus', comment: null });
    assert.strictEqual(invalidReview.review_status, 'new');
    const notFoundReview = await store.setReview('testcase-audit-store-nope', { status: 'defect', comment: 'x' });
    assert.strictEqual(notFoundReview, null);

    // REVIEW_STATUSES vocabulary is stable.
    assert.deepStrictEqual([...store.REVIEW_STATUSES].sort(), ['defect', 'needs_review', 'new', 'ok']);

    fs.unlinkSync(path.join(AUDIT_DIR, `${record.id}.json`));
    delete process.env.AUDIT_STORE_FORCE_FILE;

    console.log('auditStore: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
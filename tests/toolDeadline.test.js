'use strict';

// Production 2026-09-29: a knowledge search in /lite ran >10s; the user heard
// the bridge phrase and then nothing. Every tool call now has a total
// deadline below the realtime tool turn timeout, and returns a structured
// result the model can answer from.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bindTool, toolDeadlineMs } = require('../src/tools/toolHelpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('default tool deadline is below the 20s tool turn timeout', () => {
    const prev = process.env.TOOL_DEADLINE_MS;
    delete process.env.TOOL_DEADLINE_MS;
    try {
        assert.ok(toolDeadlineMs() < Number(process.env.PTT_TOOL_TURN_TIMEOUT_MS || 20000));
    } finally {
        if (prev !== undefined) process.env.TOOL_DEADLINE_MS = prev;
    }
});

test('a slow tool returns tool_timeout at the deadline instead of hanging', async () => {
    process.env.TOOL_DEADLINE_MS = '80';
    try {
        const logs = [];
        const handler = bindTool({ name: 'search_wine_knowledge', impl: async () => { await sleep(400); return { ok: true }; } }, { log: (stage, extra) => logs.push({ stage, ...extra }) });
        const startedAt = Date.now();
        const result = await handler({ args: { query: 'Purcari' }, generationId: 'g1', turnId: 't1' });
        assert.equal(result.error, 'tool_timeout');
        assert.ok(Date.now() - startedAt < 300, 'returned at the deadline');
        assert.ok(/Answer briefly and honestly/.test(result.message), 'the model is told to still answer');
        assert.ok(logs.some((l) => l.stage === 'tool_timeout' && l.tool === 'search_wine_knowledge'));
    } finally {
        delete process.env.TOOL_DEADLINE_MS;
    }
});

test('a fast tool is unchanged', async () => {
    const handler = bindTool({ name: 'search_wine_knowledge', impl: async () => ({ ok: true, answer: 'x' }) }, {});
    assert.deepEqual(await handler({ args: {}, generationId: 'g1', turnId: 't1' }), { ok: true, answer: 'x' });
});

test('errors still collapse to the opaque code', async () => {
    const handler = bindTool({ name: 'search_wine_knowledge', impl: async () => { throw new Error('db down'); } }, {});
    assert.deepEqual(await handler({ args: {}, generationId: 'g1', turnId: 't1' }), { error: 'tool_execution_failed' });
});

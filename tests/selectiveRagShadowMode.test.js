'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const TOOL_PATH = require.resolve('../src/tools/searchLayeredKnowledge');
const ENV_PATH = require.resolve('../src/config/env');
const ROUTER_PATH = require.resolve('../src/knowledge/selectiveRagRouter');

function freshRequireTool() {
    delete require.cache[TOOL_PATH];
    delete require.cache[ENV_PATH];
    // eslint-disable-next-line global-require
    return require('../src/tools/searchLayeredKnowledge');
}

function withEnv(mode, fn) {
    const prev = process.env.SELECTIVE_RAG_MODE;
    if (mode === undefined) delete process.env.SELECTIVE_RAG_MODE;
    else process.env.SELECTIVE_RAG_MODE = mode;
    delete require.cache[ENV_PATH];
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.SELECTIVE_RAG_MODE;
        else process.env.SELECTIVE_RAG_MODE = prev;
        delete require.cache[ENV_PATH];
    }
}

// Injects a fake module body at ROUTER_PATH so require() returns it instead
// of the real selectiveRagRouter.js -- used only to prove a throwing router
// can never break the production request.
function withFakeRouterModule(exportsObj, fn) {
    const prevCacheEntry = require.cache[ROUTER_PATH];
    const fakeModule = new Module(ROUTER_PATH, null);
    fakeModule.filename = ROUTER_PATH;
    fakeModule.loaded = true;
    fakeModule.exports = exportsObj;
    require.cache[ROUTER_PATH] = fakeModule;
    try {
        return fn();
    } finally {
        if (prevCacheEntry) require.cache[ROUTER_PATH] = prevCacheEntry;
        else delete require.cache[ROUTER_PATH];
    }
}

function fakeRouteImpl(response) {
    const calls = [];
    return {
        calls,
        impl: async (query, options) => {
            calls.push({ query, options });
            return response;
        },
    };
}

const RESULT_FOUND = {
    found: true,
    answerable: true,
    used_levels: ['documents'],
    web_used: false,
    web_reason: null,
    web_attempted: false,
    evidence: [{ level: 'documents', text: 'x', title: 't', source: 's', confidence: 'high' }],
    conflicts: [],
    freshness_sensitive: false,
    query_intent: 'general',
    answer_policy: {},
};

async function run() {
    console.log('Running Selective RAG shadow-mode tests...');

    // --- OFF (explicit and default): behavior identical to pre-shadow code -----
    console.log('Testing: SELECTIVE_RAG_MODE=off leaves the production call and result untouched...');
    await withEnv('off', async () => {
        const { createImpl } = freshRequireTool();
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args);
        try {
            const { calls, impl: routeImpl } = fakeRouteImpl(RESULT_FOUND);
            const impl = createImpl(routeImpl);
            const result = await impl({ query: 'Что такое Fetească Neagră?' }, {});
            assert.strictEqual(calls.length, 1, 'production routeImpl must still be called exactly once');
            assert.strictEqual(result.found, true);
            assert.strictEqual(result.status, 'found');
            assert.ok(!logs.some((l) => l[0] === '[selective_rag_shadow]'), 'no shadow log line when mode is off');
        } finally {
            console.log = origLog;
        }
    });

    console.log('Testing: SELECTIVE_RAG_MODE unset defaults to off (same as explicit off)...');
    await withEnv(undefined, async () => {
        const { createImpl } = freshRequireTool();
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args);
        try {
            const { impl: routeImpl } = fakeRouteImpl(RESULT_FOUND);
            const impl = createImpl(routeImpl);
            await impl({ query: 'Что такое Fetească Neagră?' }, {});
            assert.ok(!logs.some((l) => l[0] === '[selective_rag_shadow]'), 'no shadow log line when mode is unset');
        } finally {
            console.log = origLog;
        }
    });

    // --- SHADOW: router runs, decision logged, production path unchanged ------
    console.log('Testing: SELECTIVE_RAG_MODE=shadow calls the router, logs the decision, and still returns the OLD pipeline result unmodified...');
    await withEnv('shadow', async () => {
        const { createImpl } = freshRequireTool();
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args);
        try {
            const { calls, impl: routeImpl } = fakeRouteImpl(RESULT_FOUND);
            const impl = createImpl(routeImpl);
            const result = await impl({ query: 'Какое вино подойдёт к стейку?' }, { recentTurns: [] });

            assert.strictEqual(calls.length, 1, 'production routeImpl must still run exactly once in shadow mode');
            assert.deepStrictEqual(result.evidence, RESULT_FOUND.evidence, 'shadow must not alter the returned evidence');
            assert.strictEqual(result.found, RESULT_FOUND.found, 'shadow must not alter found');
            assert.strictEqual(result.answerable, true, 'shadow must not alter answerable');

            const shadowLog = logs.find((l) => l[0] === '[selective_rag_shadow]');
            assert.ok(shadowLog, 'shadow decision must be logged');
            const payload = JSON.parse(shadowLog[1]);
            assert.ok(['DIRECT', 'GROUNDED'].includes(payload.route), 'logged route must be DIRECT or GROUNDED');
            assert.ok(typeof payload.routerLatencyMs === 'number');
            assert.ok(typeof payload.retrievalLatencyMs === 'number');
            assert.ok(typeof payload.totalLatencyMs === 'number');
            assert.strictEqual(payload.error, null);
        } finally {
            console.log = origLog;
        }
    });

    // --- Router failure: production request must still succeed ----------------
    console.log('Testing: a throwing routeSelective() never breaks the production request in shadow mode...');
    await withEnv('shadow', async () => {
        await withFakeRouterModule({
            routeSelective: () => { throw new Error('boom: simulated router crash'); },
        }, async () => {
            const { createImpl } = freshRequireTool();
            const logs = [];
            const origLog = console.log;
            console.log = (...args) => logs.push(args);
            try {
                const { calls, impl: routeImpl } = fakeRouteImpl(RESULT_FOUND);
                const impl = createImpl(routeImpl);
                const result = await impl({ query: 'Расскажи про Purcari' }, {});

                assert.strictEqual(calls.length, 1, 'production routeImpl must still run even though the router threw');
                assert.strictEqual(result.found, true, 'production result must be returned unmodified despite router failure');

                const shadowLog = logs.find((l) => l[0] === '[selective_rag_shadow]');
                assert.ok(shadowLog, 'a shadow log line must still be emitted, recording the failure');
                const payload = JSON.parse(shadowLog[1]);
                assert.strictEqual(payload.route, null);
                assert.ok(String(payload.error || '').includes('boom'), 'error must be captured in the log payload');
            } finally {
                console.log = origLog;
            }
        });
    });

    // --- Latency: router overhead stays in the low single-digit milliseconds --
    console.log('Testing: router overhead stays well under the <10ms shadow-mode target...');
    await withEnv('shadow', async () => {
        const { createImpl } = freshRequireTool();
        const logs = [];
        const origLog = console.log;
        console.log = (...args) => logs.push(args);
        try {
            const { impl: routeImpl } = fakeRouteImpl(RESULT_FOUND);
            const impl = createImpl(routeImpl);
            await impl({ query: 'Какое вино для романтического ужина?' }, {});
            const payload = JSON.parse(logs.find((l) => l[0] === '[selective_rag_shadow]')[1]);
            assert.ok(payload.routerLatencyMs < 10, `router latency ${payload.routerLatencyMs}ms must stay under 10ms`);
        } finally {
            console.log = origLog;
        }
    });

    // Reset module cache to the real router module for any tests that follow
    // in the same process.
    freshRequireTool();

    console.log('ALL SELECTIVE RAG SHADOW-MODE TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error('Selective RAG shadow-mode tests failed:', error);
        process.exit(1);
    });
}

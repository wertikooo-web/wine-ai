'use strict';

// Production 29 Sep: a voice question about Purcari waited >12s in
// search_wine_knowledge. The internal levels ran one after another and the
// freshness web search only started after all of them. Same decisions, less
// waiting: internal levels run concurrently and a freshness/force_web search
// starts together with them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeKnowledge } = require('../src/knowledge/layeredRouter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slowAdapters(levelMs, webMs, calls) {
    const item = (level, score = 0.9) => ({ level, title: level, text: `${level} text`, source: `https://example.org/${level}`, relevance_score: score });
    return {
        searchCanonical: async () => { calls.push('canonical'); await sleep(levelMs); return []; },
        searchRelations: async () => { calls.push('relations'); await sleep(levelMs); return []; },
        searchCatalog: async () => { calls.push('catalog'); await sleep(levelMs); return []; },
        searchDocuments: async () => { calls.push('documents'); await sleep(levelMs); return [item('documents', 0.2)]; },
        searchInternet: async () => { calls.push('web'); await sleep(webMs); return [item('web')]; },
    };
}

test('internal levels run concurrently and a freshness web search starts with them', async () => {
    const calls = [];
    const startedAt = Date.now();
    const result = await routeKnowledge('Какие новости у винодельни Purcari за последнюю неделю?', { adapters: slowAdapters(100, 150, calls) });
    const elapsed = Date.now() - startedAt;
    assert.ok(result.freshness_sensitive, 'freshness question');
    assert.ok(result.web_used, 'web still used for freshness');
    assert.ok(calls.includes('web') && calls.includes('documents') && calls.includes('canonical'));
    assert.equal(calls.filter((c) => c === 'web').length, 1, 'web called once, not twice');
    assert.ok(elapsed < 350, `took ${elapsed}ms (sequential was ~550ms)`);
    assert.ok(result.attempts.every((a) => typeof a.durationMs === 'number'), 'per-level timings recorded');
    assert.ok(typeof result.timing_ms === 'number');
});

test('a non-freshness question does not start web early (decision unchanged)', async () => {
    const calls = [];
    const adapters = slowAdapters(20, 20, calls);
    adapters.searchCanonical = async () => { calls.push('canonical'); return [{ level: 'canonical', title: 'Cricova', text: 'Cricova address', source: 'canonical', relevance_score: 0.9 }]; };
    const result = await routeKnowledge('Где находится Cricova?', { adapters });
    assert.ok(!calls.includes('web'), 'strong internal evidence: no web');
    assert.equal(result.web_used, false);
});

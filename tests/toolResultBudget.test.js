'use strict';

// Cost (production audit 2026-10-01): knowledge tool results are compacted
// for the model only; instructions, URLs and operator news stay verbatim,
// other tools pass through, and the Gemini Live sliding window config.

const assert = require('assert');
const {
    compactToolResultForModel, wrapToolHandlersWithBudget, toolResultBudgetConfig, pickInferenceClaims,
} = require('../src/realtime/toolResultBudget');
const { geminiContextWindowCompression } = require('../src/realtime/geminiLiveProvider');

const LONG = 'Факт о вине. '.repeat(120);
const URL = `https://wine.md/ru/catalog/wine/${'x'.repeat(500)}`;

function bigKnowledgeResult() {
    const evidence = Array.from({ length: 12 }, (_, i) => ({
        level: i === 9 ? 'canonical' : 'documents',
        text: `${i === 9 ? 'CANON ' : ''}${LONG}`,
        title: `Doc ${i}`,
        source: URL,
        provenance: { entity_id: `e${i}`, chunk: i },
        relevance_score: 0.5,
    }));
    return {
        found: true,
        status: 'found',
        evidence,
        results: evidence,
        claims: evidence.map((e, i) => ({ id: `claim_${i}`, claim: e.text, kind: 'document_supported_fact', conflict: i === 2 ? { values: ['a', 'b'] } : null, freshness: { dynamic: false, as_of: null } })),
        conflicts: [],
        operator_news: [{ title: 'News', text: LONG }],
        answer_policy: { rules: ['r1', 'r2'], final_instruction: `Answer from the "inference" block. ${LONG}` },
        recovery: { applied: true, final_instruction: `Answer from the "inference" block. ${LONG}` },
        inference: {
            scenario: 'recommend_wine',
            found: true,
            explanation: ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'Точные цены в каталоге пока не подтверждены.'],
            inference: { wines: [{ name: 'Negru de Purcari' }] },
            claims: [
                { kind: 'document_supported_fact', claim: `Relation filler ${LONG}` },
                { kind: 'document_supported_fact', claim: `Another filler ${LONG}` },
                { kind: 'document_supported_fact', claim: `Third filler ${LONG}` },
                { kind: 'document_supported_fact', claim: `Fourth filler ${LONG}` },
                { kind: 'document_supported_fact', claim: `Fifth filler ${LONG}` },
                { kind: 'verified_fact', claim: 'Negru de Purcari: vintage 2019, gold medal', source: { title: 'Purcari', url: URL } },
                { kind: 'ai_inference', claim: 'explanation joined' },
            ],
        },
    };
}

async function run() {
    let n = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
    const raw = bigKnowledgeResult();
    const out = compactToolResultForModel(raw);
    const c = out.result;
    ok(out.compacted && out.afterChars < out.beforeChars / 5, `compacted ${out.beforeChars} -> ${out.afterChars}`);
    ok(c.evidence.length === 4, 'over budget after pass 1: stricter pass 2 applied (budget is soft for verbatim parts)');
    ok(!('results' in c), 'duplicate results list dropped');
    ok(c.evidence[0].text.startsWith('CANON'), 'evidence capped, canonical ranked first');
    ok(c.evidence.every((e) => !('provenance' in e) && !('relevance_score' in e)), 'provenance/score dropped');
    ok(c.evidence.every((e) => e.source === URL), 'URLs never trimmed');
    ok(c.claims.length === 1 && c.claims[0].conflict, 'top-level claims keep only conflicts');
    ok(c.answer_policy.final_instruction === raw.answer_policy.final_instruction, 'final_instruction verbatim');
    ok(c.answer_policy.rules.length === 2, 'rules verbatim');
    ok(c.operator_news[0].text === LONG, 'operator news verbatim');
    ok(!('final_instruction' in c.recovery) && c.recovery.applied === true, 'duplicate recovery instruction dropped');
    ok(c.inference.explanation.length === 6 && /не подтверждены/.test(c.inference.explanation[5]), 'all explanation caveats kept');
    ok(c.inference.claims[0].kind === 'verified_fact' && /Negru de Purcari/.test(c.inference.claims[0].claim), 'claim about the recommended wine ranked first');
    ok(c.inference.claims.every((x) => x.kind !== 'ai_inference'), 'ai_inference claim dropped');
    ok(c.inference.claims[0].source.url === URL, 'claim source url kept');
    ok(pickInferenceClaims({ claims: [] }, 3).length === 0, 'empty inference claims safe');

    const small = { found: true, evidence: [{ text: 'short' }], results: [{ text: 'short' }] };
    ok(compactToolResultForModel(small).result === small, 'under budget: untouched');
    ok(compactToolResultForModel(null).result === null && compactToolResultForModel([1]).result.length === 1, 'non-object passes');

    const big = bigKnowledgeResult();
    const handlers = {
        search_wine_knowledge: async () => big,
        fetch_page: async () => ({ text: LONG.repeat(10) }),
        not_a_function: 1,
    };
    const logged = [];
    const wrapped = wrapToolHandlersWithBudget(handlers, { config: { enabled: true, budgetChars: 9000 }, onCompacted: (i) => logged.push(i) });
    const k = await wrapped.search_wine_knowledge({});
    ok(!('results' in k) && logged.length === 1 && logged[0].tool === 'search_wine_knowledge', 'knowledge tool compacted and logged');
    ok(wrapped.fetch_page === handlers.fetch_page, 'fetch_page passes through untouched');
    ok(wrapped.not_a_function === 1, 'non-function entries kept');
    ok(big.results.length === 12, 'the tool result object itself is not mutated');
    ok(wrapToolHandlersWithBudget(handlers, { config: { enabled: false } }) === handlers, 'TOOL_RESULT_COMPACT=off disables');
    ok(toolResultBudgetConfig({ TOOL_RESULT_COMPACT: 'off' }).enabled === false && toolResultBudgetConfig({}).budgetChars === 9000, 'config parsing');

    ok(JSON.stringify(geminiContextWindowCompression({})) === JSON.stringify({ triggerTokens: '14000', slidingWindow: { targetTokens: '12000' } }), 'default sliding window 14000/12000');
    ok(geminiContextWindowCompression({ GEMINI_CONTEXT_TRIGGER_TOKENS: 'off' }) === null, 'window can be switched off');
    const custom = geminiContextWindowCompression({ GEMINI_CONTEXT_TRIGGER_TOKENS: '20000', GEMINI_CONTEXT_TARGET_TOKENS: '25000' });
    ok(custom.triggerTokens === '20000' && Number(custom.slidingWindow.targetTokens) < 20000, 'target always below trigger');
    ok(geminiContextWindowCompression({ GEMINI_CONTEXT_TRIGGER_TOKENS: '3000' }).triggerTokens === '14000', 'trigger below Gemini minimum falls back to default');
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`toolResultBudget passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

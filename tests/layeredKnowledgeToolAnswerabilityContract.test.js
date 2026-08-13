'use strict';

const assert = require('assert');
const tool = require('../src/tools/searchLayeredKnowledge');
const { LEVELS, routeKnowledgeWithAnswerabilityGate } = require('../src/knowledge/layeredRouter');

function similarButIrrelevantFragment(index) {
    return {
        level: LEVELS.DOCUMENTS,
        text: `Общая информация о винодельне номер ${index}: история региона и виноградарства Молдовы.`,
        title: `Fragment ${index}`,
        source: `https://example.md/doc-${index}`,
        confidence: 'medium',
        relevance_score: 0.5,
    };
}

function adapters({ documentItems = [], webItems = [] } = {}) {
    const calls = [];
    return {
        calls,
        value: {
            searchCanonical: async () => { calls.push('canonical'); return []; },
            searchCatalog: async () => { calls.push('catalog'); return []; },
            searchDocuments: async () => { calls.push('documents'); return documentItems; },
            searchInternet: async () => { calls.push('web'); return webItems; },
        },
    };
}

// Wires the tool to the real gate, but with injected adapters/answerability
// model -- this is the same production code path (routeKnowledgeWithAnswerabilityGate)
// the live realtime assistant now uses via searchLayeredKnowledge.js's default
// export, just with retrieval/grading stubbed for a deterministic test.
function toolImplWithGate({ documentItems, webItems, answerable, reason }) {
    const { value, calls } = adapters({ documentItems, webItems });
    const routeImpl = (query, options) => routeKnowledgeWithAnswerabilityGate(query, {
        ...options,
        adapters: value,
        answerabilityModel: { generateContent: async () => ({ text: JSON.stringify({ answerable, reason }) }) },
    });
    return { impl: tool.createImpl(routeImpl), calls };
}

async function run() {
    console.log('Running Live Voice Tool Answerability Contract Tests...');
    const context = { log: () => {} };
    // All queries below mention "Cricova" (a known winery) so they classify
    // as 'own_entity', not 'general_wine' -- this isolates these tests to
    // the gate's own two-phase check-then-fallback logic, distinct from the
    // separate eager-web-for-general-wine-topics behavior covered by
    // tests/retrievalAnswerabilityGate.test.js's eager-web-specific blocks.

    // Core regression case, but through the REAL live tool
    // (search_wine_knowledge), not just the router in isolation: 8
    // similar-but-irrelevant fragments -> found:true, initial answerable:false,
    // then a web fallback fires (the tool always passes allowWeb:true --
    // unchanged from before this gate existed) and, since it genuinely
    // finds something, the final outcome flips to a confident answer.
    console.log('Testing: live tool with 8 similar-but-irrelevant fragments -> found:true, web fallback fires and confirms...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => similarButIrrelevantFragment(i + 1));
        const { impl, calls } = toolImplWithGate({
            documentItems: eightFragments,
            webItems: [{
                level: LEVELS.WEB, text: 'Баранину хорошо сочетать с насыщенным красным вином.', title: 'Pairing guide',
                source: 'https://example.com/pairing', source_type: 'general_web', confidence: 'medium',
            }],
            answerable: false,
            reason: 'fragments are generic background info, no pairing recommendation',
        });

        const result = await impl({ query: 'Какое вино Cricova выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true, 'found must be true -- fragments were genuinely retrieved');
        assert.ok(calls.includes('web'), 'the web adapter must have been called, since the initial check said answerable:false');
        assert.strictEqual(result.webUsed, true, 'web fallback must have found something');
        assert.strictEqual(result.answerable, true, 'a web fallback that genuinely finds evidence must resolve to answerable:true');
        assert.strictEqual(result.answerabilityReason, 'confirmed_via_web_fallback');
        assert.strictEqual(result.status, 'found', 'status must reflect a confirmed answer once web genuinely supplied one');
        assert.ok(!/cannot be reliably confirmed/i.test(result.answer_policy.final_instruction),
            'once web has confirmed an answer, the model must be told to answer confidently, not refuse');
    }

    console.log('Testing: live tool -- answerability check unavailable (unknown), web fallback fires and confirms...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => similarButIrrelevantFragment(i + 1));
        const { value } = adapters({
            documentItems: eightFragments,
            webItems: [{
                level: LEVELS.WEB, text: 'Баранину хорошо сочетать с насыщенным красным вином.', title: 'Pairing guide',
                source: 'https://example.com/pairing', source_type: 'general_web', confidence: 'medium',
            }],
        });
        // No generateContent, no apiKey -> checkAnswerability's unavailable
        // (unknown) branch -- must be routed to web exactly like an
        // explicit answerable:false, never treated as a silent pass.
        const routeImpl = (query, options) => routeKnowledgeWithAnswerabilityGate(query, { ...options, adapters: value, answerabilityModel: { apiKey: '' } });
        const impl = tool.createImpl(routeImpl);

        const result = await impl({ query: 'Какое вино Cricova выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.webUsed, true, 'an unknown/unavailable check must still route to web, not skip it');
        assert.strictEqual(result.answerable, true, 'a successful web fallback resolves the unknown check to a confident answer');
        assert.strictEqual(result.status, 'found');
    }

    console.log('Testing: same fragments but the caller context still results in an honest refusal path when web adds nothing new...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => similarButIrrelevantFragment(i + 1));
        // Web is attempted (webItems empty -> web_used stays false) so the
        // tool must recover to the closest supported facts (partial evidence)
        // rather than pretend the fragments answer the pairing question.
        const { impl } = toolImplWithGate({
            documentItems: eightFragments,
            webItems: [],
            answerable: false,
            reason: 'no pairing information anywhere in the evidence',
        });

        const result = await impl({ query: 'Какое вино Cricova выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.answerable, false, 'the assistant must not imitate knowledge it does not have');
        assert.strictEqual(result.webUsed, false, 'web found nothing new, so webUsed correctly stays false');
        assert.strictEqual(result.status, 'recovered', 'the answer path must recover to the closest supported facts instead of a dead-end refusal');
        assert.ok(result.recovery && result.recovery.applied === true, 'a recovery block must be attached');
        assert.strictEqual(result.recovery.strategy, 'partial_evidence');
        assert.ok(result.claims.length > 0, 'recovery must supply provenance-carrying claims');
        assert.ok(result.claims.every((claim) => claim.source && (claim.source.url || claim.source.title || claim.source.document_page)),
            'every recovered claim must carry provenance');
        assert.ok(/Only part of this question can be confirmed right now/i.test(result.answer_policy.final_instruction),
            'the model must be told to answer only the confirmed part, not the whole question');
        assert.ok(/Do not invent the unconfirmed part/i.test(result.answer_policy.final_instruction),
            'recovery must keep the anti-fabrication limit explicit');
    }

    console.log('Testing: a genuinely covering fragment -> found:true, answerable:true, no web call, confident-answer instruction...');
    {
        const { impl, calls } = toolImplWithGate({
            documentItems: [{
                level: LEVELS.DOCUMENTS, text: 'Баранину традиционно подают с плотными красными винами, например Фетяска Нягрэ.',
                title: 'Pairing guide', source: 'wine.md/pairing', confidence: 'high', relevance_score: 0.9,
            }],
            webItems: [],
            answerable: true,
            reason: 'direct pairing recommendation present',
        });

        const result = await impl({ query: 'Какое вино Cricova выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.answerable, true);
        assert.strictEqual(result.webUsed, false, 'no web fallback should fire when the evidence already answers the question');
        assert.strictEqual(result.status, 'found');
        assert.ok(!calls.includes('web'), 'searchInternet must not be called when answerable');
    }

    console.log('ALL LIVE VOICE TOOL ANSWERABILITY CONTRACT TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error('Live voice tool answerability contract tests failed:', error);
        process.exit(1);
    });
}

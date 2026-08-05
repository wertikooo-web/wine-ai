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

    // Core regression case, but through the REAL live tool
    // (search_wine_knowledge), not just the router in isolation: 8
    // similar-but-irrelevant fragments -> found:true, answerable:false,
    // then a web fallback once allowWeb is permitted (the tool always
    // passes allowWeb:true -- unchanged from before this gate existed).
    console.log('Testing: live tool with 8 similar-but-irrelevant fragments -> found:true, answerable:false, web fallback fires...');
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

        const result = await impl({ query: 'Какое вино выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true, 'found must be true -- fragments were genuinely retrieved');
        assert.strictEqual(result.answerable, false, 'answerable must be false -- the fragments do not cover the pairing question');
        assert.strictEqual(result.answerabilityReason, 'fragments are generic background info, no pairing recommendation');
        assert.strictEqual(result.webUsed, true, 'web fallback must have fired since the live tool always permits web');
        assert.strictEqual(result.status, 'insufficient', 'status must reflect found-but-insufficient, not a plain "found"');
        assert.ok(calls.includes('web'), 'the web adapter must actually have been called');
        assert.ok(result.answer_policy.final_instruction.toLowerCase().includes('cannot be reliably confirmed') || result.answer_policy.final_instruction.toLowerCase().includes('honest'),
            'the instruction given to the model must tell it to answer honestly, not fabricate a pairing from loosely-related evidence');
        assert.ok(/do not (mention|guess)/i.test(result.answer_policy.final_instruction),
            'the instruction must explicitly tell the model not to expose internal search machinery or guess');
    }

    console.log('Testing: same fragments but the caller context still results in an honest refusal path when web adds nothing new...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => similarButIrrelevantFragment(i + 1));
        // Web is attempted (webItems empty -> web_used stays false) so the
        // tool must still surface an honest "insufficient" outcome, not a
        // confident answer, once evidence truly cannot confirm the fact.
        const { impl } = toolImplWithGate({
            documentItems: eightFragments,
            webItems: [],
            answerable: false,
            reason: 'no pairing information anywhere in the evidence',
        });

        const result = await impl({ query: 'Какое вино выбрать к баранине?' }, context);

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.answerable, false, 'the assistant must not imitate knowledge it does not have');
        assert.strictEqual(result.webUsed, false, 'web found nothing new, so webUsed correctly stays false');
        assert.strictEqual(result.status, 'insufficient');
        assert.ok(/cannot be reliably confirmed|honest/i.test(result.answer_policy.final_instruction),
            'even after an unsuccessful web attempt, the model must be told to answer honestly rather than guess');
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

        const result = await impl({ query: 'Какое вино выбрать к баранине?' }, context);

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

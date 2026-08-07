'use strict';

const assert = require('assert');
const {
    LEVELS,
    checkAnswerability,
    routeKnowledgeWithAnswerabilityGate,
} = require('../src/knowledge/layeredRouter');

function documentFragment(index, score = 0.6) {
    // Topically similar (mentions wine/Moldova) but never actually answers a
    // specific pairing question -- exactly the "similar but irrelevant"
    // shape that produced a false found:true in production.
    return {
        level: LEVELS.DOCUMENTS,
        text: `Общая информация о винодельне номер ${index}: история региона и виноградарства Молдовы.`,
        title: `Fragment ${index}`,
        source: `https://example.md/doc-${index}`,
        confidence: 'medium',
        relevance_score: score,
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

async function run() {
    console.log('Running Retrieval Answerability Gate Tests...');

    // 1. checkAnswerability() sees only question + evidence, returns strict
    //    parsed JSON, and truncates evidence going into the prompt.
    console.log('Testing: checkAnswerability() calls the model with only question + evidence and parses strict JSON...');
    {
        let capturedPrompt = null;
        const result = await checkAnswerability(
            'Какое вино выбрать к баранине?',
            [documentFragment(1), documentFragment(2)],
            { generateContent: async ({ prompt }) => { capturedPrompt = prompt; return { text: '{"answerable": false, "reason": "no pairing mentioned"}' }; } }
        );
        assert.strictEqual(result.answerable, false, 'must parse answerable:false from strict JSON');
        assert.strictEqual(result.reason, 'no pairing mentioned', 'must parse the reason field');
        assert.ok(capturedPrompt.includes('Какое вино выбрать к баранине?'), 'prompt must include the question');
        assert.ok(capturedPrompt.includes('Fragment 1'), 'prompt must include evidence titles');
        assert.ok(!capturedPrompt.includes('cellars'), 'prompt must not include unrelated persona/system content -- only question + evidence');
    }

    // For a live assistant, "the grader is unreachable" must read as
    // UNKNOWN (null), never as a silent pass -- a pass would skip the web
    // fallback and let a random, topically-similar fragment stand in for a
    // verified answer.
    console.log('Testing: checkAnswerability() reports answerable:null (unknown, not a pass) on unparseable model output...');
    {
        const result = await checkAnswerability('Вопрос?', [documentFragment(1)], {
            generateContent: async () => ({ text: 'not json at all' }),
        });
        assert.strictEqual(result.answerable, null, 'unparseable grader output must be unknown, not answerable:true');
        assert.strictEqual(result.reason, 'answerability_check_unparseable');
    }

    console.log('Testing: checkAnswerability() reports answerable:null when no apiKey/generateContent is configured...');
    {
        const result = await checkAnswerability('Вопрос?', [documentFragment(1)], { apiKey: '' });
        assert.strictEqual(result.answerable, null, 'a missing grader configuration must be unknown, not a silent pass');
        assert.strictEqual(result.reason, 'answerability_check_unavailable');
    }

    console.log('Testing: checkAnswerability() reports answerable:null when the grader call itself throws...');
    {
        const result = await checkAnswerability('Вопрос?', [documentFragment(1)], {
            generateContent: async () => { throw new Error('network error'); },
        });
        assert.strictEqual(result.answerable, null, 'a grader outage must be unknown, not a silent pass');
        assert.strictEqual(result.reason, 'answerability_check_error');
    }

    console.log('Testing: checkAnswerability() with no evidence is trivially not answerable...');
    {
        const result = await checkAnswerability('Вопрос?', [], {});
        // claimClass/entityMatch are the answerability-gate sprint's added
        // fields: with zero evidence there is nothing to classify against, so
        // both are null and the gate falls back to its own deterministic
        // claim-class classifier.
        assert.deepStrictEqual(result, {
            answerable: false, reason: 'no_evidence', claimClass: null, entityMatch: null,
        });
    }

    // 2. The core regression case: 8 similar-but-irrelevant document
    //    fragments -> found:true, answerable:false, web fallback fires when
    //    allowed -- and, since the web pass here genuinely turns up
    //    something, the final answerable flips to true so the model can
    //    confidently answer from the fresh web evidence.
    console.log('Testing: 8 similar-but-irrelevant fragments -> found:true, initial answerable:false, web fallback fires and confirms...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => documentFragment(i + 1, 0.5));
        const { value, calls } = adapters({
            documentItems: eightFragments,
            webItems: [{
                level: LEVELS.WEB, text: 'Баранину хорошо сочетать с насыщенным красным вином.', title: 'Wine pairing guide',
                source: 'https://example.com/pairing', source_type: 'general_web', confidence: 'medium',
            }],
        });
        const answerabilityImpl = async () => ({ text: '{"answerable": false, "reason": "fragments are generic, no pairing info"}' });

        // Deliberately phrased to mention a known winery (Cricova) so this
        // classifies as 'own_entity', NOT 'general_wine' -- keeps this test
        // isolated to the gate's own two-phase check-then-fallback logic,
        // not the separate eager-web-for-general-wine-topics behavior
        // (covered by its own dedicated tests further below).
        const result = await routeKnowledgeWithAnswerabilityGate('Какое вино Cricova выбрать к баранине?', {
            allowWeb: true,
            adapters: value,
            answerabilityModel: { generateContent: answerabilityImpl },
        });

        assert.strictEqual(result.found, true, 'found must stay true -- fragments genuinely were retrieved');
        assert.ok(calls.includes('web'), 'searchInternet must actually have been called, since the initial check said answerable:false');
        assert.strictEqual(result.web_used, true, 'web fallback must have found something');
        assert.strictEqual(result.answerable, true, 'a web fallback that genuinely finds evidence must resolve to answerable:true, not stay stuck on the original false');
        assert.strictEqual(result.answerabilityReason, 'confirmed_via_web_fallback');
        assert.ok(result.evidence.some((item) => item.level === LEVELS.WEB), 'web evidence must be merged into the final evidence list');
        assert.ok(result.evidence.length > eightFragments.length, 'web evidence must be added on top of the original fragments, not replace them');
    }

    console.log('Testing: same 8 irrelevant fragments, allowWeb:false -> found:true, answerable:false, no web call...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => documentFragment(i + 1, 0.5));
        const { value, calls } = adapters({ documentItems: eightFragments });
        const answerabilityImpl = async () => ({ text: '{"answerable": false, "reason": "no pairing info"}' });

        // Deliberately phrased to mention a known winery (Cricova) so this
        // classifies as 'own_entity', NOT 'general_wine' -- keeps this test
        // isolated to the gate's own two-phase check-then-fallback logic,
        // not the separate eager-web-for-general-wine-topics behavior
        // (covered by its own dedicated tests further below).
        const result = await routeKnowledgeWithAnswerabilityGate('Какое вино Cricova выбрать к баранине?', {
            allowWeb: false,
            adapters: value,
            answerabilityModel: { generateContent: answerabilityImpl },
        });

        assert.strictEqual(result.found, true, 'found must still be true -- fragments were retrieved');
        assert.strictEqual(result.answerable, false, 'the honest answerable:false signal must survive even without web permission');
        assert.strictEqual(result.web_used, false, 'web must never be called when allowWeb:false, regardless of answerability');
        assert.ok(!calls.includes('web'), 'searchInternet must not be invoked');
    }

    console.log('Testing: fragments that DO answer the question -> answerable:true, no web call even when allowed...');
    {
        const { value, calls } = adapters({
            documentItems: [{
                level: LEVELS.DOCUMENTS, text: 'Баранину традиционно подают с плотными красными винами, например Фетяска Нягрэ.',
                title: 'Pairing guide', source: 'wine.md/pairing', confidence: 'high', relevance_score: 0.9,
            }],
        });
        const answerabilityImpl = async () => ({ text: '{"answerable": true, "reason": "direct pairing recommendation present"}' });

        // Deliberately phrased to mention a known winery (Cricova) so this
        // classifies as 'own_entity', NOT 'general_wine' -- keeps this test
        // isolated to the gate's own two-phase check-then-fallback logic,
        // not the separate eager-web-for-general-wine-topics behavior
        // (covered by its own dedicated tests further below).
        const result = await routeKnowledgeWithAnswerabilityGate('Какое вино Cricova выбрать к баранине?', {
            allowWeb: true,
            adapters: value,
            answerabilityModel: { generateContent: answerabilityImpl },
        });

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.answerable, true, 'a genuinely covering fragment must be reported answerable');
        assert.strictEqual(result.web_used, false, 'no web fallback is needed when the evidence already answers the question');
        assert.ok(!calls.includes('web'), 'searchInternet must not be invoked when answerable');
    }

    console.log('Testing: no evidence at all -> found:false, answerable:false, no answerability model call...');
    {
        let checkCalled = false;
        const { value } = adapters({ documentItems: [] });
        const result = await routeKnowledgeWithAnswerabilityGate('Полностью неизвестный вопрос', {
            allowWeb: true,
            adapters: value,
            answerabilityModel: { generateContent: async () => { checkCalled = true; return { text: '{"answerable":true,"reason":"x"}' }; } },
        });
        assert.strictEqual(result.found, false);
        assert.strictEqual(result.answerable, false);
        assert.strictEqual(checkCalled, false, 'the answerability check must be skipped entirely when there is no evidence to grade');
    }

    console.log('Testing: freshness-triggered web (routeKnowledge\'s own logic) is not double-checked by the gate...');
    {
        const { value, calls } = adapters({
            documentItems: [documentFragment(1, 0.5)],
            webItems: [{ level: LEVELS.WEB, text: 'Открыто сегодня с 9 до 18.', title: 'Hours', source: 'https://example.com', source_type: 'official_winery', confidence: 'high' }],
        });
        let answerabilityCalled = false;
        const result = await routeKnowledgeWithAnswerabilityGate('Какие часы работы винодельни сегодня?', {
            allowWeb: true,
            adapters: value,
            answerabilityModel: { generateContent: async () => { answerabilityCalled = true; return { text: '{"answerable":false,"reason":"x"}' }; } },
        });
        assert.strictEqual(result.web_used, true, 'freshness detection should have already triggered web inside routeKnowledge');
        assert.strictEqual(answerabilityCalled, false, 'the gate must not run an extra answerability check once web was already used');
    }

    // 3. The unknown/unavailable case: the grader itself is unreachable
    //    (no apiKey, network error, etc). This must NOT silently skip the
    //    web fallback like the old answerable:true fail-open used to --
    //    "unknown" is routed to web exactly like "no".
    console.log('Testing: answerability check unavailable -> treated as unknown -> web fallback still fires -> empty web result -> insufficient...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => documentFragment(i + 1, 0.5));
        const { value, calls } = adapters({ documentItems: eightFragments, webItems: [] });

        // Deliberately phrased to mention a known winery (Cricova) so this
        // classifies as 'own_entity', NOT 'general_wine' -- keeps this test
        // isolated to the gate's own two-phase check-then-fallback logic,
        // not the separate eager-web-for-general-wine-topics behavior
        // (covered by its own dedicated tests further below).
        const result = await routeKnowledgeWithAnswerabilityGate('Какое вино Cricova выбрать к баранине?', {
            allowWeb: true,
            adapters: value,
            // No generateContent and no apiKey -> checkAnswerability's
            // unavailable branch (answerable: null).
            answerabilityModel: { apiKey: '' },
        });

        assert.strictEqual(result.found, true, 'found must stay true -- fragments were retrieved');
        assert.strictEqual(calls.includes('web'), true, 'web fallback must fire even though the check was unavailable, not skipped like a silent pass');
        assert.notStrictEqual(result.answerable, true, 'an unavailable check followed by an empty web result must never resolve to answerable:true');
        assert.strictEqual(result.web_used, false, 'web was attempted but found nothing, so web_used correctly stays false');
        assert.strictEqual(result.answerabilityReason, 'answerability_check_unavailable', 'the original unavailable reason must survive when web adds nothing');
    }

    console.log('Testing: answerability check unavailable -> web fallback fires -> web DOES find something -> treated as answered...');
    {
        const eightFragments = Array.from({ length: 8 }, (_, i) => documentFragment(i + 1, 0.5));
        const { value, calls } = adapters({
            documentItems: eightFragments,
            webItems: [{
                level: LEVELS.WEB, text: 'Баранину хорошо сочетать с насыщенным красным вином.', title: 'Pairing guide',
                source: 'https://example.com/pairing', source_type: 'general_web', confidence: 'medium',
            }],
        });

        // Deliberately phrased to mention a known winery (Cricova) so this
        // classifies as 'own_entity', NOT 'general_wine' -- keeps this test
        // isolated to the gate's own two-phase check-then-fallback logic,
        // not the separate eager-web-for-general-wine-topics behavior
        // (covered by its own dedicated tests further below).
        const result = await routeKnowledgeWithAnswerabilityGate('Какое вино Cricova выбрать к баранине?', {
            allowWeb: true,
            adapters: value,
            answerabilityModel: { apiKey: '' },
        });

        assert.ok(calls.includes('web'), 'web fallback must have fired');
        assert.strictEqual(result.web_used, true, 'web genuinely found something');
        assert.strictEqual(result.answerable, true, 'a successful web fallback after an unknown check must resolve to answerable:true so the model can answer confidently from the new evidence');
        assert.strictEqual(result.answerabilityReason, 'confirmed_via_web_fallback');
    }

    console.log('ALL RETRIEVAL ANSWERABILITY GATE TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((err) => {
        console.error('Retrieval answerability gate tests failed:', err);
        process.exit(1);
    });
}

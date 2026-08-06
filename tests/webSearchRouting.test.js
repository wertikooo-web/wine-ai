'use strict';

const assert = require('assert');
const {
    LEVELS,
    classifyQueryIntent,
    routeKnowledge,
    KNOWN_WINERY_NAMES,
} = require('../src/knowledge/layeredRouter');

function adapters({ canonicalItems = [], catalogItems = [], documentItems = [], webItems = [] } = {}) {
    const calls = [];
    return {
        calls,
        value: {
            searchCanonical: async () => { calls.push('canonical'); return canonicalItems; },
            searchCatalog: async () => { calls.push('catalog'); return catalogItems; },
            searchDocuments: async () => { calls.push('documents'); return documentItems; },
            searchInternet: async () => { calls.push('web'); return webItems; },
        },
    };
}

function webItem(title = 'Result') {
    return { level: LEVELS.WEB, text: 'snippet', title, source: 'https://example.com', source_type: 'general_web', confidence: 'medium' };
}

async function run() {
    console.log('Running Web Search Routing Tests...');

    // --- classifyQueryIntent ---------------------------------------------
    console.log('Testing: classifyQueryIntent covers all four tiers correctly...');
    assert.strictEqual(classifyQueryIntent('Сколько стоит Cricova Brut?'), 'own_entity', 'catalog-intent query -> own_entity');
    assert.strictEqual(classifyQueryIntent('Где находится Cricova?'), 'own_entity', 'a bare mention of a known winery name -> own_entity, even for a generic "где" question');
    assert.strictEqual(classifyQueryIntent('Расскажите про Purcari'), 'own_entity');
    assert.strictEqual(classifyQueryIntent('Какое вино выбрать к стейку?'), 'general_wine', 'wine-related, no partner mention -> general_wine');
    assert.strictEqual(classifyQueryIntent('Что такое терруар?'), 'general_wine');
    assert.strictEqual(classifyQueryIntent('Кто такой Роберт Паркер?'), 'off_topic_factual', 'not wine-related, but asks a factual question -> off_topic_factual');
    assert.strictEqual(classifyQueryIntent('Какая погода в Кишинёве?'), 'off_topic_factual');
    assert.strictEqual(classifyQueryIntent('Спасибо большое, было очень приятно!'), 'off_topic_smalltalk', 'ordinary thanks/smalltalk -> off_topic_smalltalk, no factual content');
    assert.ok(KNOWN_WINERY_NAMES.includes('Cricova'), 'the default known-entity list must include our actual partner wineries');

    // --- own_entity: web stays fallback-only, unchanged from before -------
    console.log('Testing: own_entity queries keep web as fallback-only (strong internal evidence -> no web)...');
    {
        const stub = adapters({
            canonicalItems: [{ level: LEVELS.CANONICAL, text: 'x', title: 'Cricova', source: 'db', confidence: 'verified' }],
            documentItems: [{ level: LEVELS.DOCUMENTS, text: 'x', title: 'Cricova', source: 'doc', confidence: 'high', relevance_score: 0.9 }],
            webItems: [webItem()],
        });
        const result = await routeKnowledge('История винодельни Cricova', { adapters: stub.value });
        assert.strictEqual(result.query_intent, 'own_entity');
        assert.strictEqual(result.web_attempted, false, 'strong internal evidence must still suppress web for own_entity queries');
        assert.ok(!stub.calls.includes('web'), 'searchInternet must never be called when internal evidence is already strong for our own entity');
    }

    // --- general_wine: web fires eagerly, even with strong internal -------
    console.log('Testing: general_wine queries call web eagerly, in parallel, regardless of internal evidence strength...');
    {
        const stub = adapters({
            documentItems: [{ level: LEVELS.DOCUMENTS, text: 'x', title: 'Pairing', source: 'doc', confidence: 'high', relevance_score: 0.95 }],
            webItems: [webItem('Terroir explained')],
        });
        const result = await routeKnowledge('Что такое терруар в виноделии?', { adapters: stub.value });
        assert.strictEqual(result.query_intent, 'general_wine');
        assert.strictEqual(result.web_used, true, 'web must run even though internal evidence is already strong -- eager, not fallback-only');
        assert.strictEqual(result.web_reason, 'general_wine_topic');
        assert.ok(stub.calls.includes('web'));
        assert.ok(result.evidence.some((item) => item.level === LEVELS.WEB));
    }

    // Regression: when there are more (generic, weakly-relevant) internal
    // documents than the downstream 8-item evidence slice can hold, eager
    // web results must not be crowded out entirely -- otherwise the web
    // call runs and finds the answer, but nothing downstream (grader, final
    // answer prompt) ever sees it, because plain level-rank ties still lose
    // to internal on stable-sort insertion order.
    console.log('Testing: eager web survives an 8-item truncation even when outnumbered by generic internal documents...');
    {
        const manyGenericDocs = Array.from({ length: 10 }, (_, i) => ({
            level: LEVELS.DOCUMENTS, text: `generic wine content ${i}`, title: `Doc ${i}`, source: 'doc', confidence: 'high', relevance_score: 0.9,
        }));
        const stub = adapters({
            documentItems: manyGenericDocs,
            webItems: [webItem('Robert Parker bio')],
        });
        const result = await routeKnowledge('Кто такой Роберт Паркер?', { adapters: stub.value });
        assert.strictEqual(result.query_intent, 'off_topic_factual');
        const top8 = result.evidence.slice(0, 8);
        assert.ok(top8.some((item) => item.level === LEVELS.WEB), 'the web result must survive into the first 8 evidence items, not be pushed past them by 10 generic docs');
    }

    // --- off_topic_factual: web allowed; smalltalk: web never fires -------
    console.log('Testing: off_topic_factual gets web, off_topic_smalltalk never does...');
    {
        const stub = adapters({ webItems: [webItem('Robert Parker bio')] });
        const result = await routeKnowledge('Кто такой Роберт Паркер?', { adapters: stub.value });
        assert.strictEqual(result.query_intent, 'off_topic_factual');
        assert.strictEqual(result.web_used, true);
        assert.strictEqual(result.web_reason, 'off_topic_factual');
    }
    {
        const stub = adapters({ webItems: [webItem('should never be used')] });
        const result = await routeKnowledge('Спасибо, было очень приятно с вами общаться!', { adapters: stub.value });
        assert.strictEqual(result.query_intent, 'off_topic_smalltalk');
        assert.strictEqual(result.web_used, false, 'smalltalk must never trigger a web call -- nothing to look up, don\'t burn budget');
        assert.ok(!stub.calls.includes('web'));
    }

    // --- allowWeb:false suppresses eager web too ---------------------------
    console.log('Testing: allowWeb:false suppresses eager web even for general_wine/off_topic_factual...');
    {
        const stub = adapters({ documentItems: [{ level: LEVELS.DOCUMENTS, text: 'x', title: 'T', source: 'd', confidence: 'high', relevance_score: 0.9 }] });
        const result = await routeKnowledge('Что такое терруар в виноделии?', { adapters: stub.value, allowWeb: false });
        assert.strictEqual(result.web_used, false);
        assert.ok(!stub.calls.includes('web'));
    }

    // --- KOS/internal facts about our own partners keep priority ----------
    console.log('Testing: for our own partner facts, internal/canonical evidence sorts ahead of general web evidence...');
    {
        const stub = adapters({
            canonicalItems: [{ level: LEVELS.CANONICAL, text: 'address: Chisinau', title: 'Cricova', source: 'db', confidence: 'verified' }],
            webItems: [webItem('Some blog about Cricova')],
        });
        // Not freshness-sensitive, so canonical alone makes internal strong;
        // own_entity intent (mentions Cricova) keeps web fallback-only, and
        // strong internal evidence suppresses it -- our own data wins by
        // simply never being second-guessed by an unrequested web call.
        const result = await routeKnowledge('Где находится Cricova?', { adapters: stub.value });
        assert.strictEqual(result.web_used, false);
        assert.strictEqual(result.evidence[0].level, LEVELS.CANONICAL, 'our own canonical fact about a partner must rank first when present');
    }

    console.log('ALL WEB SEARCH ROUTING TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run };

if (require.main === module) {
    run().catch((err) => {
        console.error('Web search routing tests failed:', err);
        process.exit(1);
    });
}

'use strict';

const assert = require('assert');
const {
    LEVELS,
    routeKnowledge,
    isFreshnessQuery,
    isCatalogQuery,
    naturalAnswerPolicy,
    detectConflicts,
    queryTokens,
} = require('../src/knowledge/layeredRouter');

const canonical = (text = 'country: Moldova') => ({
    level: LEVELS.CANONICAL,
    text,
    title: 'cricova',
    source: 'https://official.example',
    confidence: 'verified',
    provenance: { entity_id: 'cricova' },
});
const catalog = () => ({
    level: LEVELS.CATALOG,
    text: 'Cricova Brut',
    title: 'Cricova Brut',
    source: 'https://wine.md/cricova-brut',
    confidence: 'verified',
    catalog: { external_id: 'cricova-brut', price: 199, currency: 'MDL', availability: 'in_stock' },
});
const document = (score = 0.8) => ({
    level: LEVELS.DOCUMENTS,
    text: 'Cricova has historic underground cellars.',
    title: 'Cricova history',
    source: 'cricova.md',
    confidence: 'high',
    relevance_score: score,
});
const web = () => ({
    level: LEVELS.WEB,
    text: 'Tours are available today.',
    title: 'Official visit page',
    source: 'https://cricova.md/visit',
    source_type: 'official_winery',
    confidence: 'high',
});

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

async function run() {
    assert.strictEqual(isCatalogQuery('Сколько стоит Cricova Brut и есть ли в наличии?'), true);
    assert.strictEqual(isCatalogQuery('Расскажи историю винодельни Cricova'), false);
    assert.strictEqual(isFreshnessQuery('Какое сейчас расписание экскурсий?'), true);
    assert.strictEqual(isFreshnessQuery('Care este prețul acum?'), true);
    assert.strictEqual(isFreshnessQuery('What is the current stock?'), true);
    assert.strictEqual(isFreshnessQuery('Из какого сорта делают это вино?'), false);
    assert.deepStrictEqual(queryTokens('Что известно о Cricova Brut?'), ['что', 'известно', 'cricova', 'brut']);

    const policy = naturalAnswerPolicy();
    assert.strictEqual(policy.disclose_internal_search_process, false);
    assert.strictEqual(policy.tone, 'confident_clear');
    assert.ok(policy.rules.some((rule) => rule.includes('Do not say that the internal database lacked information')));
    assert.ok(policy.rules.some((rule) => rule.includes('Do not announce that web search was used')));

    // Strong canonical/document evidence stops before web for stable facts.
    {
        const stub = adapters({ canonicalItems: [canonical()], documentItems: [document()] });
        const result = await routeKnowledge('Где находится Cricova?', { adapters: stub.value });
        assert.deepStrictEqual(stub.calls, ['canonical', 'documents']);
        assert.strictEqual(result.web_attempted, false);
        assert.deepStrictEqual(result.used_levels, [LEVELS.CANONICAL, LEVELS.DOCUMENTS]);
        assert.strictEqual(result.evidence[0].level, LEVELS.CANONICAL);
    }

    // Catalog intent checks structured catalog, and freshness also checks web.
    {
        const stub = adapters({ catalogItems: [catalog()], documentItems: [document()], webItems: [web()] });
        const result = await routeKnowledge('Сколько сейчас стоит Cricova Brut?', { adapters: stub.value });
        assert.deepStrictEqual(stub.calls, ['canonical', 'catalog', 'documents', 'web']);
        assert.strictEqual(result.catalog_intent, true);
        assert.strictEqual(result.web_attempted, true);
        assert.strictEqual(result.evidence[0].level, LEVELS.CATALOG);
        assert.ok(result.used_levels.includes(LEVELS.WEB));
    }

    // Weak internal search falls back to web. This query is wine-related
    // ("вино"), so it classifies as general_wine -- web now runs eagerly,
    // concurrently with internal retrieval, rather than strictly after it;
    // call ORDER between the two concurrent branches is not guaranteed
    // (unlike the old sequential fallback), only that all three sources
    // were actually consulted.
    {
        const stub = adapters({ documentItems: [document(0.2)], webItems: [web()] });
        const result = await routeKnowledge('Новое неизвестное вино', { adapters: stub.value });
        assert.deepStrictEqual([...stub.calls].sort(), ['canonical', 'documents', 'web']);
        assert.strictEqual(result.web_used, true);
    }

    // allowWeb=false keeps the request fully internal.
    {
        const stub = adapters({ documentItems: [document(0.1)], webItems: [web()] });
        const result = await routeKnowledge('Неизвестное вино', { adapters: stub.value, allowWeb: false });
        assert.deepStrictEqual(stub.calls, ['canonical', 'documents']);
        assert.strictEqual(result.web_attempted, false);
        assert.strictEqual(result.web_used, false);
    }

    // One level failing never crashes the whole route.
    {
        const stub = adapters({ documentItems: [document()] });
        stub.value.searchCanonical = async () => { stub.calls.push('canonical'); throw new Error('db down'); };
        const result = await routeKnowledge('История Cricova', { adapters: stub.value });
        assert.strictEqual(result.found, true);
        assert.ok(result.attempts.some((item) => item.level === LEVELS.CANONICAL && item.status === 'error'));
    }

    // Concrete conflicts are surfaced rather than silently merged.
    {
        const conflicts = detectConflicts([
            canonical('address: Strada A'),
            canonical('address: Strada B'),
            { ...catalog(), catalog: { ...catalog().catalog, price: 199 } },
            { ...catalog(), catalog: { ...catalog().catalog, price: 220 } },
        ]);
        assert.strictEqual(conflicts.length, 2);
        assert.ok(conflicts.some((item) => item.key === 'cricova:address'));
        assert.ok(conflicts.some((item) => item.key === 'cricova-brut:price'));
    }

    console.log('layeredKnowledgeRouter: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };

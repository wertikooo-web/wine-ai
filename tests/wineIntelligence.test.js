'use strict';

// Phase 6 Wine Intelligence layer contract (src/knowledge/wineIntelligence.js).
//
// Pins the explainable-inference contract:
//   - four deterministic scenarios (food pairing, recommendation, comparison,
//     route planning) are detected and answered only from retrieved evidence,
//   - every successful inference returns reasons, provenance-carrying evidence,
//     and a confidence; the recommendation summary is a single `ai_inference`
//     claim, never a verified fact,
//   - when the knowledge base cannot support the ask, the layer says exactly
//     what is missing instead of inventing a winery, bottle, price, vintage,
//     or award,
//   - adapters are injectable so every path below uses deterministic evidence
//     and never touches a database, network, or LLM.

const assert = require('assert');
const {
    SCENARIOS,
    detectScenario,
    parseRecommendationPreferences,
    runInference,
    buildInferenceClaims,
} = require('../src/knowledge/wineIntelligence');

const ADAPTERS = Object.freeze({
    searchRelations: async () => [],
    searchCanonical: async () => [],
    searchCatalog: async () => [],
    searchDocuments: async () => [],
    searchInternet: async () => [],
});

function canonical(title, text, source = 'docs/canonical.md') {
    return { level: 'canonical', title, source, confidence: 'high', text, relevance_score: 0.9 };
}

function catalog(title, price, profile = {}) {
    return {
        level: 'catalog',
        title,
        source: 'wine.md',
        confidence: 'high',
        text: `${title} — ${price} MDL`,
        catalog: { price, last_synced_at: '2026-08-01', profile },
        relevance_score: 0.9,
    };
}

function relation(subjectId, predicate, objectValue, title = subjectId) {
    return {
        level: 'canonical',
        title,
        source: 'docs/canonical.md',
        confidence: 'high',
        text: `${title} ${predicate} ${objectValue}`,
        structured_kind: 'entity_relation',
        relation: { subject_id: subjectId, predicate, object_value: objectValue, object_id: null },
        relevance_score: 0.9,
    };
}

async function run() {
    console.log('Running Wine Intelligence Tests...');

    // ---------------------------------------------------------------- scenario detection ----
    assert.strictEqual(detectScenario('Сравни Cricova и Purcari'), SCENARIOS.COMPARE_WINES);
    assert.strictEqual(detectScenario('Составь маршрут по винодельням Молдовы'), SCENARIOS.PLAN_ROUTE);
    assert.strictEqual(detectScenario('Что подать к стейку?'), SCENARIOS.PAIR_FOOD);
    assert.strictEqual(detectScenario('Посоветуй красное сухое вино до 200 леев'), SCENARIOS.RECOMMEND_WINE);
    assert.strictEqual(detectScenario('Расскажи о виноделии'), null, 'non-scenario wine question stays null');

    // ---------------------------------------------------------------- preference parsing ----
    const prefs = parseRecommendationPreferences('Посоветуй красное сухое вино до 200 леев к баранине');
    assert.strictEqual(prefs.color, 'red');
    assert.strictEqual(prefs.sweetness, 'dry');
    assert.strictEqual(prefs.budget, 200);
    assert.strictEqual(prefs.food, 'lamb');

    // ---------------------------------------------------------------- food pairing ----
    {
        const result = await runInference('Что подать к баранине?', { adapters: ADAPTERS });
        assert.strictEqual(result.scenario, SCENARIOS.PAIR_FOOD);
        assert.strictEqual(result.found, true);
        assert.ok(result.explanation.length > 0, 'pairing must return human-readable reasons');
        assert.ok(result.inference && result.inference.candidates.length > 0, 'pairing must name candidate styles');
        assert.strictEqual(result.claims.some((c) => c.kind === 'ai_inference'), true,
            'the AI conclusion must be an ai_inference claim, never a verified fact');
        result.claims.forEach((c) => assert.notStrictEqual(c.kind, 'verified_fact', 'no inference is a verified fact'));
    }

    // ---------------------------------------------------------------- recommendation ----
    {
        const evidence = [
            catalog('Negru de Purcari', 380, { grapes: ['rara neagra', 'feteasca neagra'], color: 'red', body: 3, acidity: 3, sweetness: 1, tannin: 2 }),
            relation('purcari', 'produces', 'Negru de Purcari', 'Purcari'),
            relation('purcari', 'located_in', 'Valul lui Traian', 'Purcari'),
            relation('purcari', 'made_from', 'feteasca neagra', 'Negru de Purcari'),
        ];
        const result = await runInference('Посоветуй красное вино до 400 леев', { adapters: { ...ADAPTERS, ...{ searchCatalog: async () => [evidence[0]], searchRelations: async () => evidence.slice(1), searchCanonical: async () => [] } } });
        assert.strictEqual(result.scenario, SCENARIOS.RECOMMEND_WINE);
        assert.strictEqual(result.found, true);
        const wines = result.inference.wines || [];
        assert.ok(wines.some((w) => String(w.name).toLowerCase().includes('negru de purcari')),
            'a matching catalog wine must be recommended');
        assert.ok(wines.every((w) => w.style), 'every recommended wine carries a style');
    }

    // ---------------------------------------------------------------- comparison ----
    {
        const evidence = [
            relation('cricova', 'produces', 'Cricova Brut', 'Cricova'),
            relation('purcari', 'produces', 'Negru de Purcari', 'Purcari'),
            relation('cricova', 'located_in', 'Codru', 'Cricova'),
            relation('purcari', 'located_in', 'Valul lui Traian', 'Purcari'),
        ];
        const result = await runInference('Сравни Cricova и Purcari', { adapters: { ...ADAPTERS, ...{ searchRelations: async () => evidence } } });
        assert.strictEqual(result.scenario, SCENARIOS.COMPARE_WINES);
        assert.strictEqual(result.found, true);
        assert.ok(result.inference.attributes.length >= 2, 'comparison must produce a row per attribute');
        assert.ok(result.explanation.some((line) => /Сравнение/i.test(line)));
    }

    // ---------------------------------------------------------------- route planning ----
    {
        const evidence = [
            relation('cricova', 'offers_tour', 'true', 'Cricova'),
            relation('purcari', 'offers_tasting', 'true', 'Purcari'),
            relation('castel-mimi', 'located_in', 'Codru', 'Castel Mimi'),
        ];
        const result = await runInference('Составь маршрут по винодельням на день', { adapters: { ...ADAPTERS, ...{ searchRelations: async () => evidence } } });
        assert.strictEqual(result.scenario, SCENARIOS.PLAN_ROUTE);
        assert.strictEqual(result.found, true);
        assert.ok(result.inference.stops.length >= 2, 'route must list discovered wineries');
    }

    // ---------------------------------------------------------------- missing-data honesty ----
    // No wine matches the ask -> the layer says what is missing, never invents
    // a bottle. (Sparkling is chosen because the confirmed official profiles
    // contain no sparkling bottle, so an empty-evidence ask must stay empty.)
    {
        const result = await runInference('Посоветуй игристое вино', { adapters: ADAPTERS });
        assert.strictEqual(result.found, false);
        assert.ok(result.missing.length > 0, 'unsupported recommendation must state what is missing');
    }

    // Comparison with only one named wine -> ask, do not invent the second.
    {
        const result = await runInference('Сравни Cricova', { adapters: ADAPTERS });
        assert.strictEqual(result.found, false);
        assert.ok(result.missing.some((m) => /два/i.test(m) || /двух/i.test(m)),
            'a one-sided comparison must request the second wine');
    }

    // ---------------------------------------------------------------- claims contract ----
    {
        const evidence = [canonical('Fact', 'Castel Mimi produces Fetească Neagră.', 'docs/canonical.md')];
        const claims = buildInferenceClaims({ found: true, evidence, explanation: ['Recommendation text.'], confidence: 'high' });
        assert.ok(claims.some((c) => c.claim === 'Recommendation text.' && c.kind === 'ai_inference'));
        assert.ok(claims.filter((c) => c.kind !== 'ai_inference').every((c) => c.source && (c.source.url || c.source.document_page)),
            'supporting evidence claims must carry provenance (the ai_inference summary is a synthetic conclusion, not sourced evidence)');
    }

    console.log('ALL WINE INTELLIGENCE TESTS PASSED!');
}

run().catch((error) => {
    console.error('Wine intelligence tests failed:', error);
    process.exit(1);
});
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
const tool = require('../src/tools/searchLayeredKnowledge');
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

    // Natural, wine-entity-free phrasings the live assistant must also route
    // into Phase 6 (production intent broadening).
    assert.strictEqual(detectScenario('Что взять к утке?'), SCENARIOS.PAIR_FOOD, 'duck pairing without the word wine');
    assert.strictEqual(detectScenario('Хочу мягкое красное'), SCENARIOS.RECOMMEND_WINE, 'preference without the word wine');
    assert.strictEqual(detectScenario('Хочу сухое белое до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget+colour preference');
    assert.strictEqual(detectScenario('Что попробовать вместо Purcari?'), SCENARIOS.RECOMMEND_WINE, 'alternative recommendation');
    assert.strictEqual(detectScenario('Cricova или Purcari для дегустации?'), SCENARIOS.COMPARE_WINES, 'two wineries joined by or');
    assert.strictEqual(detectScenario('Посоветуй молдавское красное'), SCENARIOS.RECOMMEND_WINE, 'moldovan colour preference');
    assert.strictEqual(detectScenario('Помоги выбрать вино на праздник'), SCENARIOS.RECOMMEND_WINE, 'help me choose');
    assert.strictEqual(detectScenario('Какое вино подать к баранине?'), SCENARIOS.PAIR_FOOD, 'wine-to-dish phrasing');
    assert.strictEqual(detectScenario('Сколько стоит вино Cricova 1952'), null, 'factual price question stays null');
    // Blocker 1 (verifier): a factual attribute ask stays non-inference even
    // when it also carries recommendation vocabulary.
    assert.strictEqual(detectScenario('Подскажи цену на красное вино Cricova 1952'), null, 'price ask with intent vocab stays factual');
    assert.strictEqual(detectScenario('Хочу узнать цену красного вина Cricova'), null, 'price ask with хочу stays factual');
    assert.strictEqual(detectScenario('Подскажи, какая крепость у вина Cricova?'), null, 'strength ask stays factual');
    assert.strictEqual(detectScenario('Посоветуй, сколько стоит вино Negru de Purcari?'), null, 'price ask with посоветуй stays factual');
    // Verifier round-2 sharp edges: the factual-attribute gate generalizes to
    // entity-named attribute targets and Cyrillic inflections (ASCII `\w*`
    // would never match "алкоголя"/"градусов"), while budget constraints
    // stay recommendation asks.
    assert.strictEqual(detectScenario('Подскажи цену на Cricova'), null, 'bare-entity price ask stays factual');
    assert.strictEqual(detectScenario('Подскажи цену Cricova 1952'), null, 'bare-entity price ask without на stays factual');
    assert.strictEqual(detectScenario('Подскажи крепость Cricova'), null, 'bare-entity strength ask stays factual');
    assert.strictEqual(detectScenario('Подскажи, сколько алкоголя в вине Cricova?'), null, 'alcohol ask with Cyrillic inflection stays factual');
    assert.strictEqual(detectScenario('Сколько алкоголя в вине Cricova'), null, 'alcohol ask without intent verb stays factual');
    assert.strictEqual(detectScenario('Какой производитель у Cricova?'), null, 'producer ask stays factual');
    assert.strictEqual(detectScenario('Какие сорта винограда у Cricova?'), null, 'grape ask stays factual');
    assert.strictEqual(detectScenario('Сколько градусов в Cricova?'), null, 'degrees ask stays factual');
    assert.strictEqual(detectScenario('Хочу красное вино по цене до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget constraint is NOT a factual ask');
    assert.strictEqual(detectScenario('Хочу красное вино не дороже 400 леев'), SCENARIOS.RECOMMEND_WINE, 'budget constraint stays recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино в пределах 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget constraint stays recommendation');
    // Verifier round-3 sharp edge: a price word physically separated from the
    // budget token by a descriptor word is still a budget recommendation, not
    // a factual attribute ask.
    assert.strictEqual(detectScenario('Подскажи цену на красное вино до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget recommendation with price word stays recommendation');
    assert.strictEqual(detectScenario('Посоветуй цену красного вина до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget recommendation with посоветуй stays recommendation');
    assert.strictEqual(detectScenario('Хочу узнать цену красного вина до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'budget recommendation with хочу узнать stays recommendation');
    assert.strictEqual(detectScenario('Подскажи цену на сухое вино до 300'), SCENARIOS.RECOMMEND_WINE, 'budget recommendation without леев stays recommendation');
    // Verifier round-4 sharp edges: a budget token next to a NAMED wine does
    // NOT turn a factual attribute ask into a recommendation, and "по N" is a
    // budget phrase that rescues generic-wine recommendations.
    assert.strictEqual(detectScenario('Подскажи цену на красное вино Cricova 1952 до 300 леев'), null, 'named wine + budget stays a factual price ask');
    assert.strictEqual(detectScenario('Хочу узнать цену красного вина Cricova до 300 леев'), null, 'named wine + budget stays a factual price ask');
    assert.strictEqual(detectScenario('Хочу узнать, сколько стоит вино Cricova 1952 до 300 леев'), null, 'named wine + budget stays a factual price ask');
    assert.strictEqual(detectScenario('Подскажи, какая крепость у вина Cricova до 13 градусов?'), null, 'named wine + strength unit is a factual ask, not a budget');
    assert.strictEqual(detectScenario('Сколько стоит вино Cricova 1952 до 300 леев'), null, 'named wine + budget is still a factual price ask');
    assert.strictEqual(detectScenario('Хочу узнать цену красного вина по 300 леев'), SCENARIOS.RECOMMEND_WINE, 'по N budget phrase rescues a generic recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино по 300 леев'), SCENARIOS.RECOMMEND_WINE, 'по N budget phrase is a recommendation');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино в пределах 300 леев').budget, 300, 'в пределах budget is extracted');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино по 300 леев').budget, 300, 'по budget is extracted');
    // Verifier round-5 sharp edge: a non-price unit ("до 13 градусов",
    // "до 12%", "до 1952 года", "по 300 грамм") is NOT a price budget. It must
    // not flip a factual/education attribute ask into a recommendation and must
    // never leak a phantom MDL value into prefs.budget scoring.
    assert.strictEqual(detectScenario('Хочу узнать крепость красного вина до 13 градусов'), null, 'generic strength ask with unit stays factual');
    assert.strictEqual(detectScenario('Хочу узнать, сколько алкоголя в красном вине до 13%'), null, 'generic alcohol ask with percent stays factual');
    // Verifier round-7 sharp edge: recommendation verbs (рекоменд/подбери/
    // посоветуете) fronting a factual attribute ask are question markers, so
    // the factual ask stays null; but a qualifier construction ("вино
    // крепостью до 13") is a preference, not a factual ask.
    assert.strictEqual(detectScenario('Рекомендуй цену красного вина'), null, 'рекоменд + attribute stays factual');
    assert.strictEqual(detectScenario('Подбери цену на красное вино'), null, 'подбери + attribute stays factual');
    assert.strictEqual(detectScenario('Подбери год выпуска красного вина'), null, 'подбери + выпуск stays factual');
    assert.strictEqual(detectScenario('Посоветуете цену на красное вино'), null, 'посоветуете + attribute stays factual');
    assert.strictEqual(detectScenario('Рекомендую крепость красного вина'), null, 'рекомендую + strength stays factual');
    assert.strictEqual(detectScenario('Рекомендуй цену Cricova'), null, 'рекоменд + named wine + attribute stays factual');
    assert.strictEqual(detectScenario('Подбери красное сухое до 200 леев'), SCENARIOS.RECOMMEND_WINE, 'подбери without attribute stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино до 300 леев'), SCENARIOS.RECOMMEND_WINE, 'рекоменд without attribute stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино крепостью до 13'), SCENARIOS.RECOMMEND_WINE, 'рекоменд + qualifier preference stays recommendation');
    // Verifier round-8 sharp edge: recommend verbs as question markers must not
    // over-fire on descriptor adjectives ("винтажное") or conjunction-less
    // qualifiers ("крепостью 13") -- both are recommendations, not factual asks.
    assert.strictEqual(detectScenario('Рекомендуй винтажное красное вино'), SCENARIOS.RECOMMEND_WINE, 'винтажное descriptor stays recommendation');
    assert.strictEqual(detectScenario('Подбери винтажное красное вино'), SCENARIOS.RECOMMEND_WINE, 'винтажное descriptor stays recommendation');
    assert.strictEqual(detectScenario('Посоветуете винтажное красное вино'), SCENARIOS.RECOMMEND_WINE, 'винтажное descriptor stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино крепостью 13'), SCENARIOS.RECOMMEND_WINE, 'conjunction-less strength preference stays recommendation');
    assert.strictEqual(detectScenario('Подбери красное вино крепостью 13'), SCENARIOS.RECOMMEND_WINE, 'conjunction-less strength preference stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино крепостью 13 градусов'), SCENARIOS.RECOMMEND_WINE, 'conjunction-less strength + unit stays recommendation');
    assert.strictEqual(detectScenario('Посоветуете красное вино крепостью 13'), SCENARIOS.RECOMMEND_WINE, 'conjunction-less strength preference stays recommendation');
    assert.strictEqual(parseRecommendationPreferences('Рекомендуй красное вино крепостью 13').budget, undefined, 'conjunction-less strength must not become a budget');
    // Verifier round-9 sharp edge: sugar/acidity/tannin/aging/bottling are
    // modeled factual attributes too -- a recommend verb fronting them is a
    // factual ask (null), while a sugar preference ("сахаром 30") stays a
    // recommendation and a descriptor adjective ("выдержанное") is not an
    // attribute ask.
    assert.strictEqual(detectScenario('Подскажи сахар красного вина'), null, 'sugar ask stays factual');
    assert.strictEqual(detectScenario('Подскажи кислотность красного вина'), null, 'acidity ask stays factual');
    assert.strictEqual(detectScenario('Подскажи танины красного вина'), null, 'tannin ask stays factual');
    assert.strictEqual(detectScenario('Подскажи розлив красного вина'), null, 'bottling ask stays factual');
    assert.strictEqual(detectScenario('Рекомендуй сахар красного вина'), null, 'рекоменд + sugar stays factual');
    assert.strictEqual(detectScenario('Подскажи сахар вина Cricova'), null, 'named wine + sugar stays factual');
    assert.strictEqual(detectScenario('Рекомендуй выдержку красного вина'), null, 'aging ask stays factual');
    assert.strictEqual(detectScenario('Хочу красное вино сахаром 30'), SCENARIOS.RECOMMEND_WINE, 'sugar preference stays recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино сахаром до 30 г/л'), SCENARIOS.RECOMMEND_WINE, 'sugar preference with unit stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй выдержанное красное вино'), SCENARIOS.RECOMMEND_WINE, 'выдержанное descriptor stays recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино на розлив'), SCENARIOS.RECOMMEND_WINE, 'на розлив preference stays recommendation');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино сахаром 30').budget, undefined, 'sugar amount must not become a budget');
    // Verifier round-10 sharp edge: the new attribute tokens (sugar/acidity/
    // tannin/aging/bottling) also appear as qualifiers in recommendation asks.
    // A recommend verb + qualifier+value ("с выдержкой до 5 лет", "кислотностью
    // до 3") is a preference, not a factual ask, and those values must never
    // leak as MDL budgets.
    assert.strictEqual(detectScenario('Рекомендуй красное вино с выдержкой до 5 лет'), SCENARIOS.RECOMMEND_WINE, 'aging qualifier preference stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино танинностью 5'), SCENARIOS.RECOMMEND_WINE, 'tannin qualifier preference stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй красное вино кислотностью до 3'), SCENARIOS.RECOMMEND_WINE, 'acidity qualifier preference stays recommendation');
    assert.strictEqual(detectScenario('Подбери красное вино выдержкой 300'), SCENARIOS.RECOMMEND_WINE, 'aging qualifier preference stays recommendation');
    assert.strictEqual(detectScenario('Рекомендуй сахарное красное вино'), SCENARIOS.RECOMMEND_WINE, 'сахарное adjective stays recommendation');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино танинностью до 30').budget, undefined, 'tannin amount must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино кислотностью до 30').budget, undefined, 'acidity amount must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино выдержкой до 15').budget, undefined, 'aging years must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино сладостью до 30').budget, undefined, 'sweetness amount must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино розливом до 300').budget, undefined, 'bottling volume must not become a budget');
    // Verifier round-11 confluence: a real price cap co-occurring with an
    // attribute qualifier must be kept -- the qualifier veto must not drop a
    // genuine "до N леев" constraint in the same turn.
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино с выдержкой 5 лет до 300 леев').budget, 300, 'aging qualifier + real price cap keeps budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино танинностью 5 лет до 300 леев').budget, 300, 'tannin qualifier + real price cap keeps budget');
    assert.strictEqual(parseRecommendationPreferences('Рекомендуй красное вино с выдержкой 3 года до 200 леев').budget, 200, 'aging qualifier + 200 lei cap keeps budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 300 леев').budget, 300, 'plain price cap keeps budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу узнать крепость красного вина до 13 градусов').budget, undefined, 'strength unit must not become a phantom MDL budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 1952 года').budget, undefined, 'vintage year must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино по 300 грамм').budget, undefined, 'gram unit must not become a budget');
    // Verifier round-6 sharp edges: (a) a qualifier-before-number ("крепостью
    // до 13", "объёмом до 750") is a preference, not a price budget and not a
    // factual ask; (b) abbreviated units (г, л, г/л, миллилитров) must not
    // leak phantom MDL budgets; (c) a recommendation with an attribute word
    // but no question marker must stay a recommendation.
    assert.strictEqual(detectScenario('Хочу красное вино крепостью до 13 градусов'), SCENARIOS.RECOMMEND_WINE, 'strength preference stays a recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино крепостью до 13'), SCENARIOS.RECOMMEND_WINE, 'bare strength preference stays a recommendation');
    assert.strictEqual(detectScenario('Хочу красное вино объёмом до 750'), SCENARIOS.RECOMMEND_WINE, 'volume preference stays a recommendation');
    assert.strictEqual(detectScenario('Хочу игристое с сахаром до 30 г/л'), SCENARIOS.RECOMMEND_WINE, 'sugar preference stays a recommendation');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино крепостью до 13').budget, undefined, 'qualifier-before-number must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино объёмом до 750').budget, undefined, 'volume qualifier must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 750 мл').budget, undefined, 'ml must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино по 300 г').budget, undefined, 'г must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 750 л').budget, undefined, 'л must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 750 миллилитров').budget, undefined, 'миллилитров must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу игристое с сахаром до 30 г/л').budget, undefined, 'г/л must not become a budget');
    assert.strictEqual(parseRecommendationPreferences('Хочу красное вино до 1952 года').budget, undefined, 'vintage year must not become a budget');
    // Blocker 2 (verifier): education comparisons of generic wine categories
    // carry no registry entity and must NOT hijack the comparison path.
    assert.strictEqual(detectScenario('Чем отличается красное вино от белого?'), null, 'education colour comparison stays general knowledge');
    assert.strictEqual(detectScenario('В чем разница между сухим и полусухим вином?'), null, 'education sweetness comparison stays general knowledge');
    assert.strictEqual(detectScenario('В чем отличие Cricova от Purcari?'), SCENARIOS.COMPARE_WINES, 'noun comparison between two wineries is a compare ask');
    assert.strictEqual(detectScenario('Посоветуй отличное красное вино'), SCENARIOS.RECOMMEND_WINE, 'отличное (excellent) must NOT trigger comparison');
    assert.strictEqual(detectScenario('Хочу красное яблоко'), SCENARIOS.RECOMMEND_WINE, 'descriptor+intent verb is the documented wine-tool gate');

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

    // Blocker 3 (verifier): a comparison where each side only has a bare
    // producer relation (no style/grapes/region/price) must NOT be reported
    // as a "found" comparison -- a bare producer is not a supported wine
    // attribute, and no style is ever invented from a colour word in a name.
    // (A non-registry "Fake Red A" comparison attaches no inference at all,
    // which is itself the honest outcome.)
    {
        const result = await runInference('Сравни Fake Red A и Wine B', { adapters: ADAPTERS });
        assert.strictEqual(result.found, false, 'no fabricated comparison inference is attached for unknown wines');
        assert.strictEqual(result.scenario, null, 'cars-no-registry comparison stays general knowledge');
    }
    {
        const evidence = [
            relation('cricova', 'produces', 'Cricova Brut', 'Cricova'),
            relation('purcari', 'produces', 'Negru de Purcari', 'Purcari'),
        ];
        const result = await runInference('Сравни Cricova и Purcari', { adapters: { ...ADAPTERS, ...{ searchRelations: async () => evidence, searchCanonical: async () => evidence } } });
        assert.strictEqual(result.found, false,
            'comparison without supported wine attributes must be honest not_found');
        assert.ok(result.missing.length > 0, 'insufficient comparison data must state what is missing');
        assert.ok(!String(result.missing.join(' ')).includes('Rară Neagră') && !String(result.missing.join(' ')).includes('Стиль'),
            'no invented style leaks into the honest comparison answer');
    }

    // ---------------------------------------------------------------- claims contract ----
    {
        const evidence = [canonical('Fact', 'Castel Mimi produces Fetească Neagră.', 'docs/canonical.md')];
        const claims = buildInferenceClaims({ found: true, evidence, explanation: ['Recommendation text.'], confidence: 'high' });
        assert.ok(claims.some((c) => c.claim === 'Recommendation text.' && c.kind === 'ai_inference'));
        assert.ok(claims.filter((c) => c.kind !== 'ai_inference').every((c) => c.source && (c.source.url || c.source.document_page)),
            'supporting evidence claims must carry provenance (the ai_inference summary is a synthetic conclusion, not sourced evidence)');
    }

    // ---------------------------------------------------------------- tool integration ----
    // The live search_wine_knowledge tool attaches the inference block by
    // Phase 6 INTENT, not by answer mode: the ordinary knowledge_web path
    // gets the recommendation on a Phase 6 ask, factual turns never do, and a
    // failing inference is non-fatal and leaves the retrieval outcome intact.
    {
        const doc = (text) => ({ level: 'documents', title: 'Doc', source: 'https://example.md/d', confidence: 'high', text, relevance_score: 0.9 });
        const routeImpl = async (query) => ({
            found: true, answerable: true, claim_class: 'grounding_required',
            evidence_entity_match: 'match', answerabilityReason: null,
            evidence: [doc('Castel Mimi produces Fetească Neagră.')], conflicts: [],
            used_levels: ['documents'], web_used: false, web_reason: null,
            freshness_sensitive: false, query_intent: 'own_entity',
            answer_policy: { final_instruction: 'ok' },
        });
        const impl = tool.createImpl(routeImpl);

        const webDefault = await impl({ query: 'Посоветуй красное сухое вино к баранине до 300 леев' }, { log: () => {} });
        assert.ok([SCENARIOS.PAIR_FOOD, SCENARIOS.RECOMMEND_WINE].includes(webDefault.inference.scenario),
            'default knowledge_web mode must attach the inference block when a Phase 6 intent is detected');
        assert.ok(webDefault.inference.claims.some((c) => c.kind === 'ai_inference'),
            'the inference block must carry its ai_inference claim');
        assert.strictEqual(webDefault.status, 'found', 'retrieval outcome is unchanged with inference');

        const leaky = /в\s+знаниях|каталог|relations\s+offers|база\s+данных|предпочтения:\s*\w+=/iu;
        const explainText = String(webDefault.inference.explanation.join(' '));
        const claimText = webDefault.inference.claims.find((c) => c.kind === 'ai_inference')?.claim || '';
        assert.ok(!leaky.test(explainText) && !leaky.test(claimText),
            'inference explanation/claim must not narrate database, search, or retrieval internals');
        assert.ok(/inference/.test(webDefault.answer_policy.final_instruction),
            'attaching inference must add voice-safe presentation guidance to the final instruction');

        const factual = await impl({ query: 'Сколько стоит вино Cricova 1952' }, { log: () => {} });
        assert.strictEqual(factual.inference, undefined,
            'a factual turn must NOT attach inference even in the default mode');
        assert.strictEqual(factual.status, 'found', 'retrieval outcome is unchanged without inference');

        const expert = await impl({ query: 'Посоветуй красное сухое вино к баранине до 300 леев', answer_mode: 'expert' }, { log: () => {} });
        assert.ok(expert.inference, 'expert mode keeps the inference block on a Phase 6 ask');
    }

    console.log('ALL WINE INTELLIGENCE TESTS PASSED!');
}

run().catch((error) => {
    console.error('Wine intelligence tests failed:', error);
    process.exit(1);
});
'use strict';

const assert = require('assert');
const { orchestrateKnowledge, normalizeQuestion, normalizeLanguage } = require('../src/knowledge/knowledgeOrchestrator');
const { CLAIM_KINDS } = require('../src/knowledge/claimProvenance');

function fakeRoute(overrides = {}) {
    const route = async function fakeRouteImpl(query, options) {
        route.received_options = options;
        let evidence = overrides.evidence || [];
        if (options.allowWeb && overrides.webEvidence) evidence = [...evidence, ...overrides.webEvidence];
        return {
            found: evidence.length > 0,
            evidence,
            attempts: [],
            used_levels: [...new Set(evidence.map((item) => item.level))],
            web_used: options.allowWeb && overrides.webEvidence?.length > 0,
            web_reason: null,
            web_attempted: false,
            query_intent: 'own_entity',
            freshness_sensitive: overrides.freshnessSensitive || false,
            conflicts: overrides.conflicts || [],
            answer_policy: { tone: 'confident_clear' },
            answerable: overrides.answerable ?? true,
            answerabilityReason: null,
        };
    };
    return route;
}

function canonicalItem() {
    return {
        level: 'canonical',
        text: 'founding_year: 1997',
        title: 'purcari',
        source: 'https://purcari.md',
        source_type: 'canonical',
        confidence: 'verified',
        provenance: { entity_id: 'purcari', verified_at: '2026-01-10T00:00:00.000Z' },
    };
}

function catalogItem() {
    return {
        level: 'catalog',
        text: 'Purcari Alb de Purcari',
        title: 'Alb de Purcari',
        source: 'https://wine.md/',
        source_type: 'partner_catalog',
        confidence: 'verified',
        catalog: {
            external_id: 'wine-42',
            price: 249,
            currency: 'MDL',
            availability: 'in_stock',
            last_synced_at: '2026-08-01T00:00:00.000Z',
        },
    };
}

function webItem() {
    return {
        level: 'web',
        text: 'Cricova wine festival in September',
        title: 'Visit Moldova',
        source: 'https://visit.md/events/cricova',
        source_type: 'official_event',
        confidence: 'medium',
        provenance: { url: 'https://visit.md/events/cricova', provider: 'brave' },
    };
}

async function run() {
    // Input validation.
    assert.strictEqual(normalizeLanguage('ro'), 'ro');
    assert.strictEqual(normalizeLanguage('xx'), null);
    assert.strictEqual(normalizeQuestion('  Привет  '), 'Привет');
    await assert.rejects(() => orchestrateKnowledge(''), { code: 'question_required' });
    await assert.rejects(() => orchestrateKnowledge('x'.repeat(1001)), { code: 'question_too_long' });

    // knowledge_only: catalog/web evidence stripped even when router returned it.
    const onlyRoute = fakeRoute({ evidence: [canonicalItem(), catalogItem(), webItem()] });
    const only = await orchestrateKnowledge('Сколько стоит Purcari?', {
        answerMode: 'knowledge_only',
        routeImpl: onlyRoute,
    });
    assert.strictEqual(only.answer_mode, 'knowledge_only');
    assert.deepStrictEqual(only.used_levels, ['canonical']);
    assert.strictEqual(only.web_used, false);
    assert.deepStrictEqual(only.claims.map((claim) => claim.kind), [CLAIM_KINDS.VERIFIED_FACT]);
    // Router must have been told not to consult web or catalog.
    assert.strictEqual(onlyRoute.received_options.allowWeb, false);
    assert.strictEqual(onlyRoute.received_options.allowCatalog, false);

    // knowledge_catalog: web disabled at router, catalog allowed.
    const catRoute = fakeRoute({ evidence: [canonicalItem(), catalogItem(), webItem()] });
    const catalogMode = await orchestrateKnowledge('цена', { answerMode: 'knowledge_catalog', routeImpl: catRoute });
    assert.strictEqual(catalogMode.answer_mode, 'knowledge_catalog');
    assert.deepStrictEqual(catalogMode.used_levels, ['canonical', 'catalog']);
    assert.deepStrictEqual(catalogMode.claims.map((claim) => claim.kind), [CLAIM_KINDS.VERIFIED_FACT, CLAIM_KINDS.LIVE_CATALOG_FACT]);
    assert.strictEqual(catRoute.received_options.allowWeb, false);
    assert.strictEqual(catRoute.received_options.allowCatalog, true);

    // knowledge_web: catalog + web allowed; web only enters when router returns it.
    const webRoute = fakeRoute({ evidence: [canonicalItem()], webEvidence: [webItem()] });
    const webMode = await orchestrateKnowledge('Что за событие?', { answerMode: 'knowledge_web', routeImpl: webRoute });
    assert.strictEqual(webMode.answer_mode, 'knowledge_web');
    assert.deepStrictEqual(webMode.used_levels, ['canonical', 'web']);
    assert.strictEqual(webRoute.received_options.allowWeb, true);
    assert.strictEqual(webMode.web_used, true);

    // expert: same allowed levels as web, inference permitted.
    const expert = await orchestrateKnowledge('Какое вино подобрать?', {
        answerMode: 'expert',
        routeImpl: fakeRoute({ evidence: [canonicalItem()] }),
    });
    assert.strictEqual(expert.answer_mode, 'expert');
    assert.strictEqual(expert.answerable, true);

    // Unknown mode falls back to knowledge_web (default), which allows web.
    const fallback = fakeRoute({ evidence: [canonicalItem()], webEvidence: [webItem()] });
    await orchestrateKnowledge('Привет', { answerMode: 'неизвестно', routeImpl: fallback });
    assert.strictEqual(fallback.received_options.allowWeb, true);

    // Conflicts surface per-claim and in the top-level conflicts list.
    const conflictRoute = fakeRoute({
        evidence: [catalogItem(), { ...catalogItem(), catalog: { ...catalogItem().catalog, price: 299 } }],
        conflicts: [{ key: 'wine-42:price', values: ['249', '299'] }],
        freshnessSensitive: true,
    });
    const conflicted = await orchestrateKnowledge('Цена?', { answerMode: 'knowledge_catalog', routeImpl: conflictRoute });
    assert.ok(conflicted.conflicts.length >= 1);
    const unresolved = conflicted.claims.find((claim) => claim.kind === CLAIM_KINDS.UNRESOLVED_OR_CONFLICTING);
    assert.ok(unresolved, 'conflicting claim is marked unresolved_or_conflicting');
    assert.deepStrictEqual(unresolved.conflict.values, ['249', '299']);
    assert.strictEqual(conflicted.freshness.freshness_sensitive, true);
    assert.strictEqual(conflicted.freshness.dynamic_fields_present, true);

    // narrative: natural, never exposes internal routing terms.
    const narration = await orchestrateKnowledge('Сколько стоит?', {
        routeImpl: fakeRoute({ evidence: [catalogItem()] }),
    });
    assert.ok(narration.narrative);
    const narrationText = narration.narrative.toLowerCase();
    assert.ok(!narrationText.includes('база'), 'narrative must not mention the database');
    assert.ok(!narrationText.includes('интернет'), 'narrative must not mention the internet');
    assert.ok(!narrationText.includes('распил'), 'narrative must not mention routing');
    assert.ok(!narrationText.includes('retrieval'), 'narrative must not mention retrieval');

    // No evidence: answerable reflects router, narrative null.
    const empty = await orchestrateKnowledge('Что?', { routeImpl: fakeRoute({ evidence: [] }) });
    assert.strictEqual(empty.found, false);
    assert.strictEqual(empty.claims.length, 0);
    assert.strictEqual(empty.narrative, null);

    console.log('knowledgeOrchestrator: all assertions passed');
}

async function orchestrateCall(opts) {
    return orchestrateKnowledge('Сколько стоит?', { routeImpl: opts.routeImpl });
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
'use strict';

const assert = require('assert');
const {
    runAnswerAudit,
    normalizeConstraints,
    normalizeQuestion,
    DEFAULT_MODES,
    SUPPORTED_CONSTRAINTS,
} = require('../src/knowledge/answerAudit');

function fakeRoute(evidence = []) {
    const route = async function fakeRouteImpl(query, options) {
        return {
            found: evidence.length > 0,
            evidence,
            attempts: [],
            used_levels: [...new Set(evidence.map((item) => item.level))],
            web_used: false,
            web_reason: null,
            web_attempted: false,
            query_intent: 'own_entity',
            freshness_sensitive: false,
            conflicts: [],
            answer_policy: { tone: 'confident_clear' },
            answerable: true,
            answerabilityReason: null,
        };
    };
    return route;
}

function verifiedItem() {
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

async function run() {
    // normalizeConstraints: dedupes and drops unknown codes.
    assert.deepStrictEqual(normalizeConstraints(['no_prices', 'no_web', 'bogus', 'no_prices']), ['no_prices', 'no_web']);
    assert.deepStrictEqual(normalizeConstraints('no_prices'), ['no_prices']);
    assert.deepStrictEqual(normalizeConstraints(null), []);
    assert.deepStrictEqual(normalizeConstraints([]), []);

    // normalizeQuestion validation.
    assert.throws(() => normalizeQuestion(''), { code: 'question_required' });
    assert.throws(() => normalizeQuestion('   '), { code: 'question_required' });
    assert.throws(() => normalizeQuestion('x'.repeat(1001)), { code: 'question_too_long' });
    assert.strictEqual(normalizeQuestion(' Привет '), 'Привет');

    // runAnswerAudit: validates input before any mode runs.
    await assert.rejects(() => runAnswerAudit({ question: '' }), { code: 'question_required' });

    // Single explicit mode still yields a per-mode result with metrics + latency.
    const single = await runAnswerAudit({
        question: 'Сколько стоит Purcari?',
        modes: ['knowledge_only'],
        constraints: ['no_prices'],
        routeImpl: fakeRoute([verifiedItem()]),
    });
    assert.strictEqual(single.answer_mode, 'knowledge_only');
    assert.deepStrictEqual(single.modes, ['knowledge_only']);
    assert.strictEqual(single.language, 'auto');
    assert.strictEqual(single.results.length, 1);
    const modeResult = single.results[0];
    assert.strictEqual(modeResult.answer_mode, 'knowledge_only');
    assert.ok(modeResult.latency_ms >= 0);
    assert.strictEqual(modeResult.answerable, true);
    assert.strictEqual(modeResult.claims.length, 1);
    assert.ok(typeof modeResult.metrics === 'object');
    assert.strictEqual(modeResult.metrics.answerable, true);
    assert.strictEqual(modeResult.metrics.mode_correctness.correct, true);
    assert.ok(single.id.startsWith('audit_'));
    assert.ok(single.created_at);
    assert.ok(single.latency_ms_total >= 0);

    // DEFAULT_MODES covers all four modes in the roadmap order.
    assert.deepStrictEqual(DEFAULT_MODES, ['knowledge_only', 'knowledge_catalog', 'knowledge_web', 'expert']);
    assert.strictEqual(SUPPORTED_CONSTRAINTS.includes('no_web'), true);

    const all = await runAnswerAudit({
        question: 'Что за вино?',
        routeImpl: fakeRoute([verifiedItem()]),
    });
    assert.strictEqual(all.answer_mode, 'all');
    assert.deepStrictEqual(all.modes, DEFAULT_MODES);
    assert.strictEqual(all.results.length, 4);
    assert.deepStrictEqual(all.results.map((r) => r.answer_mode), DEFAULT_MODES);

    // Constraint-aware run: no_prices metrics reflect compliance.
    const priced = await runAnswerAudit({
        question: 'Какая цена?',
        modes: ['knowledge_catalog'],
        language: 'ru',
        constraints: ['no_prices', 'no_catalog'],
        routeImpl: fakeRoute([verifiedItem()]),
    });
    assert.strictEqual(priced.language, 'ru');
    const pricedMetrics = priced.results[0].metrics;
    assert.strictEqual(pricedMetrics.constraints.compliant, true);

    console.log('answerAudit: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
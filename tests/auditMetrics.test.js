'use strict';

const assert = require('assert');
const {
    FACTUAL_KINDS,
    hasProvenance,
    provenanceCoverage,
    claimDefects,
    hallucinationRisk,
    modeCorrectness,
    constraintCompliance,
    auditMetrics,
} = require('../src/knowledge/auditMetrics');

function claim(overrides = {}) {
    return {
        id: 'claim_1',
        kind: 'verified_fact',
        claim: 'Purcari was founded in 1827.',
        confidence: 'verified',
        source: { url: 'https://purcari.md', title: 'Purcari' },
        ...overrides,
    };
}

async function run() {
    // hasProvenance: url/title/document_page/verified_at count as provenance.
    assert.strictEqual(hasProvenance(claim()), true);
    assert.strictEqual(hasProvenance(claim({ source: null })), false);
    assert.strictEqual(hasProvenance(claim({ source: { document_page: 'docs/x.md' } })), true);
    assert.strictEqual(hasProvenance(null), false);

    // provenanceCoverage counts only factual kinds; inference/unresolved are excluded.
    const covered = provenanceCoverage([
        claim(),
        claim({ kind: 'live_catalog_fact', source: { checked_at: '2026-08-01T00:00:00Z' } }),
        claim({ kind: 'current_web_fact', source: null }), // missing provenance
        claim({ kind: 'ai_inference', claim: 'Probably nice.' }),
        claim({ kind: 'unresolved_or_conflicting', claim: 'Two prices.' }),
    ]);
    assert.strictEqual(covered.total, 3);
    assert.strictEqual(covered.covered, 2);
    assert.ok(Math.abs(covered.coverage - 2 / 3) < 1e-9);
    assert.deepStrictEqual(provenanceCoverage([]), { coverage: 0, covered: 0, total: 0 });

    // claimDefects flags missing provenance + low confidence, both attributable.
    const defects = claimDefects([
        claim(),
        claim({ source: null }),
        claim({ confidence: 'low' }),
        claim({ kind: 'ai_inference', source: null }), // not a factual kind
    ]);
    assert.strictEqual(defects.length, 2);
    assert.ok(defects.some((d) => d.reason === 'missing_provenance'));
    assert.ok(defects.some((d) => d.reason === 'low_confidence'));

    // hallucinationRisk: nothing found → none; missing provenance → medium/high.
    assert.deepStrictEqual(hallucinationRisk({ found: false, claims: [] }), { risk: 'none', score: 0, reasons: ['no_evidence'] });
    const noProvenance = hallucinationRisk({ found: true, claims: [claim({ source: null })] });
    assert.ok(noProvenance.score >= 0.35);
    assert.ok(['medium', 'high'].includes(noProvenance.risk));
    const clean = hallucinationRisk({ found: true, claims: [claim()] });
    assert.strictEqual(clean.risk, 'low');

    // modeCorrectness uses allowed_levels vs used_levels.
    assert.deepStrictEqual(modeCorrectness({ allowed_levels: ['canonical'], used_levels: ['canonical'], web_used: false }), { correct: true, violations: [] });
    const violation = modeCorrectness({ allowed_levels: ['canonical'], used_levels: ['canonical', 'web'], web_used: true });
    assert.strictEqual(violation.correct, false);
    assert.ok(violation.violations.length >= 2);

    // constraintCompliance: unknown constraint is tolerated; known ones checked.
    const compliant = constraintCompliance([claim()], { constraints: ['no_prices', 'no_web'], used_levels: ['canonical'], freshness: { fields: [] } });
    assert.strictEqual(compliant.compliant, true);
    const violated = constraintCompliance([claim({ claim: 'Цена 249 lei' })], { constraints: ['no_prices'], used_levels: ['canonical'], freshness: { fields: ['price'] } });
    assert.strictEqual(violated.compliant, false);
    assert.ok(violated.checks.some((c) => c.constraint === 'no_prices' && !c.ok));
    const webViolation = constraintCompliance([claim()], { constraints: ['no_web'], used_levels: ['web'] });
    assert.strictEqual(webViolation.compliant, false);
    assert.strictEqual(constraintCompliance([claim()], { constraints: [] }).compliant, true);

    // auditMetrics: full bundle with stable keys.
    const metrics = auditMetrics({
        answerable: true,
        found: true,
        allowed_levels: ['canonical'],
        used_levels: ['canonical'],
        web_used: false,
        freshness: { fields: [] },
        constraints: ['no_prices'],
        claims: [claim()],
    });
    assert.strictEqual(metrics.answerable, true);
    assert.strictEqual(metrics.found, true);
    assert.strictEqual(metrics.provenance_coverage.covered, 1);
    assert.strictEqual(metrics.defect_count, 0);
    assert.strictEqual(metrics.inference_count, 0);
    assert.strictEqual(metrics.unresolved_count, 0);
    assert.strictEqual(metrics.factual_count, 1);
    assert.strictEqual(metrics.mode_correctness.correct, true);
    assert.strictEqual(metrics.constraints.compliant, true);
    assert.strictEqual(metrics.hallucination.risk, 'low');

    console.log('auditMetrics: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
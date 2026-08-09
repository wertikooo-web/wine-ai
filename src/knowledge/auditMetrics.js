'use strict';

// Answer Audit quality metrics (Phase 2).
//
// Pure, deterministic functions that turn one /api/knowledge/audit mode-result
// (the natural shape of orchestrateKnowledge() output) into the quality
// signals the admin screen and the benchmark need:
//   - answerability,
//   - provenance coverage,
//   - hallucination risk,
//   - inference / conflict separation,
//   - mode correctness,
//   - constraint compliance.
//
// No I/O, no model calls: a human reviewer or the benchmark can recompute
// every number from the stored audit record at any time. The vocabulary
// matches docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md §5-6.

const FACTUAL_KINDS = new Set([
    'verified_fact',
    'live_catalog_fact',
    'document_supported_fact',
    'current_web_fact',
]);

const PRICE_PATTERN = /(цена|стоим|стоит|прец|pre[țţ]ul?|price|lei|мдл|mdl|\$\s?\d|\d+\s*(?:lei|mdl))/iu;

const PRICE_VOLATILE_FIELDS = ['price', 'availability', 'stock_quantity'];

function hasProvenance(claim) {
    if (!claim || !claim.claim) return false;
    const source = claim.source || {};
    return Boolean(
        source.url
        || source.title
        || source.document_page
        || source.chunk_id
        || source.verified_at
        || source.checked_at
    );
}

// Every factual claim (verified/catalog/document/web) must carry provenance.
// Claims whose kind is not one of them (ai_inference, unresolved) are not
// "covered" by this ratio -- they are quality signals of their own.
function provenanceCoverage(claims) {
    if (!Array.isArray(claims) || !claims.length) return { coverage: 0, covered: 0, total: 0 };
    const factual = claims.filter((claim) => FACTUAL_KINDS.has(claim.kind));
    if (!factual.length) return { coverage: 1, covered: 0, total: 0 };
    const covered = factual.filter(hasProvenance).length;
    return { coverage: covered / factual.length, covered, total: factual.length };
}

// Claims whose text itself can be read as a verbatim price statement.
function priceyTextClaims(claims) {
    return (claims || []).filter((claim) => PRICE_PATTERN.test(String(claim.claim || '')));
}

// Defects: factual claims that fail the provenance gate, or low-confidence
// claims. Each defect is attributable to a single claim.
function claimDefects(claims) {
    const defects = [];
    for (const claim of claims || []) {
        if (!FACTUAL_KINDS.has(claim.kind)) continue;
        const source = claim.source || {};
        const lacksProvenance = !(
            source.url
            || source.title
            || source.document_page
            || source.chunk_id
            || source.verified_at
            || source.checked_at
        );
        if (lacksProvenance) {
            defects.push({ claim: String(claim.claim || '').slice(0, 200), reason: 'missing_provenance', confidence: claim.confidence || null });
        }
        if (claim.confidence === 'low' || claim.confidence === 'unverified') {
            defects.push({ claim: String(claim.claim || '').slice(0, 200), reason: 'low_confidence', confidence: claim.confidence });
        }
    }
    return defects;
}

// Deterministic hallucination risk from a mode result WITHOUT an LLM grader.
function hallucinationRisk(result) {
    const claims = result.claims || [];
    const total = claims.length;
    if (!result.found || total === 0) {
        return { risk: 'none', score: 0, reasons: ['no_evidence'] };
    }
    const reasons = [];
    let score = 0;
    const missing = claims.filter((c) => c.kind && c.kind !== 'ai_inference' && !hasProvenance(c)).length;
    if (missing > 0) {
        score += 0.35 + Math.min(0.35, missing * 0.1);
        reasons.push(`${missing} claim(s) without provenance source`);
    }
    const unresolved = claims.filter((c) => c.kind === 'unresolved_or_conflicting').length;
    if (unresolved > 0) {
        score += 0.2;
        reasons.push(`${unresolved} unresolved/conflicting claim(s)`);
    }
    const inferenceCount = claims.filter((c) => c.kind === 'ai_inference').length;
    if (inferenceCount > 0 && result.answerable === false) {
        score += 0.15;
        reasons.push('AI inference present while answerable=false');
    }
    if (result.answerable === false && total > 0) {
        score += 0.1;
        reasons.push('answerable=false but evidence retrieved');
    }
    const coverage = provenanceCoverage(claims);
    score = Math.min(1, Number(score.toFixed(2)));
    const risk = score >= 0.5 ? 'high' : score >= 0.2 ? 'medium' : 'low';
    return { risk, score, reasons, provenance_coverage: coverage.coverage };
}

// Which levels were actually used vs. what the mode allows.
function modeCorrectness(modeResult) {
    const allowed = new Set(modeResult.allowed_levels || []);
    const violations = [];
    for (const level of modeResult.used_levels || []) {
        if (!allowed.has(level)) violations.push(`used_level_${level}_not_allowed`);
    }
    if (modeResult.web_used && !allowed.has('web')) violations.push('web_used_but_not_allowed');
    return { correct: violations.length === 0, violations };
}

function isResultPricey(result) {
    const freshness = result.freshness || {};
    const fields = Array.isArray(freshness.fields) ? freshness.fields : [];
    return fields.some((field) => PRICE_VOLATILE_FIELDS.includes(field));
}

const CONSTRAINT_CHECKS = Object.freeze({
    no_prices: (claims, result) => {
        const violations = [...isResultPricey(result) ? ['volatile price field present'] : [], ...priceyTextClaims(claims).map((c) => c.claim)];
        return { ok: violations.length === 0, violations };
    },
    no_web: (claims, result) => {
        const used = result.used_levels || [];
        return used.includes('web') ? { ok: false, violations: ['web level used'] } : { ok: true, violations: [] };
    },
    no_catalog: (claims, result) => {
        const used = result.used_levels || [];
        return used.includes('catalog') ? { ok: false, violations: ['catalog level used'] } : { ok: true, violations: [] };
    },
    no_inference: (claims, result) => {
        const hasInference = (claims || []).some((c) => c.kind === 'ai_inference');
        return hasInference ? { ok: false, violations: ['ai_inference claim present'] } : { ok: true, violations: [] };
    },
});

// Supported constraint codes for the audit endpoint and benchmark.
const CONSTRAINT_FIELDS = Object.freeze({
    no_prices: { label: 'no price/availability claims', check: CONSTRAINT_CHECKS.no_prices },
    no_web: { label: 'no internet usage', check: CONSTRAINT_CHECKS.no_web },
    no_catalog: { label: 'no Wine.md catalog', check: CONSTRAINT_CHECKS.no_catalog },
    no_inference: { label: 'no AI inference', check: CONSTRAINT_CHECKS.no_inference },
});

function complianceForConstraint(value, claims, result) {
    const meta = CONSTRAINT_FIELDS[value];
    if (!meta) return { constraint: value, unknown: true, ok: true, violations: [] };
    const verdict = meta.check(claims, result);
    return { constraint: value, ok: verdict.ok, violations: verdict.violations };
}

function constraintCompliance(claims, result) {
    const constraints = Array.isArray(result.constraints) ? result.constraints : [];
    if (!constraints.length) return { compliant: true, checks: [] };
    const checks = constraints.map((value) => complianceForConstraint(value, claims, result));
    return { compliant: checks.every((c) => c.ok), checks };
}

// Full per-mode audit metrics from an orchestrator-shaped result.
function auditMetrics(result) {
    const claims = result.claims || [];
    const coverage = provenanceCoverage(claims);
    const defects = claimDefects(claims);
    return {
        answerable: result.answerable === true,
        found: result.found === true,
        provenance_coverage: coverage,
        defect_count: defects.length,
        defects: defects.slice(0, 20),
        hallucination: hallucinationRisk(result),
        inference_count: claims.filter((c) => c.kind === 'ai_inference').length,
        unresolved_count: claims.filter((c) => c.kind === 'unresolved_or_conflicting').length,
        factual_count: claims.filter((c) => FACTUAL_KINDS.has(c.kind)).length,
        mode_correctness: modeCorrectness(result),
        constraints: constraintCompliance(claims, result),
    };
}

module.exports = {
    FACTUAL_KINDS,
    CONSTRAINT_FIELDS,
    PRICE_VOLATILE_FIELDS,
    hasProvenance,
    provenanceCoverage,
    priceyTextClaims,
    claimDefects,
    hallucinationRisk,
    modeCorrectness,
    constraintCompliance,
    complianceForConstraint,
    auditMetrics,
};
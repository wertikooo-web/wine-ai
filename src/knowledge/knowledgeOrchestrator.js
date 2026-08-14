'use strict';

// Knowledge orchestrator -- /api/knowledge/orchestrate and the expert-level
// question path.
//
// One public contract over the four-level router + claim provenance. A caller
// passes a question and an answer mode; the orchestrator:
//   1. routes through routeKnowledgeWithAnswerabilityGate (existing behavior,
//      untouched on its own),
//   2. filters evidence to the mode's allowed levels,
//   3. classifies each evidence item into a claim with full provenance,
//   4. attaches detected conflicts,
//   5. reports freshness,
//   6. returns a natural, voice-safe answer policy (no internal-routing talk).
//
// It never generates the final user-facing sentence itself: that stays a
// model/persona responsibility. It guarantees WHAT the answer may quote and
// WHY each claim is (or is not) trustworthy.

const { routeKnowledgeWithAnswerabilityGate } = require('./layeredRouter');
const {
    resolveAnswerMode,
    modePolicy,
} = require('./answerModes');
const {
    buildClaimsFromEvidence,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
} = require('./claimProvenance');
const { attemptRecovery } = require('./usefulRecovery');
const { inferForQuestion } = require('./wineIntelligence');

function normalizeQuestion(question) {
    const text = String(question || '').trim();
    if (!text) throw Object.assign(new Error('question_required'), { code: 'question_required' });
    if (text.length > 1000) throw Object.assign(new Error('question_too_long'), { code: 'question_too_long' });
    return text;
}

function normalizeLanguage(language) {
    return ['ru', 'ro', 'en'].includes(language) ? language : null;
}

function publicClaim(claim) {
    const { _conflict_key, ...rest } = claim;
    return rest;
}

// Strongest available evidence is quoted first, uncertainty exposed, and the
// sentence is deliberately free of any internal-process vocabulary: no
// "база данных", no "поиск в интернете", no "эндпоинт".
function buildNarrative(claims, { mode, conflicts, freshness, question }) {
    if (!claims.length) {
        return null;
    }
    const ranked = rankClaims(claims);
    const strongest = ranked[0];
    const lead = `${strongest.claim}`;
    const extras = ranked.slice(1, 3)
        .filter((claim) => claim.kind === 'live_catalog_fact'
            || claim.kind === 'current_web_fact'
            || claim.kind === 'document_supported_fact')
        .map((claim) => claim.claim);
    let narrative = lead;
    if (extras.length) narrative += ` ${extras.join(' ')}`;
    if (freshness?.dynamic_fields_present && freshness.synced_through) {
        narrative += ` Актуально по состоянию на ${freshness.synced_through}.`;
    }
    if (conflicts?.length) {
        narrative += ` По этим пунктам источники расходятся, я не берусь утверждать один вариант без проверки.`;
    }
    return narrative;
}

// Voice-safe guidance appended to the final instruction when an inference
// block is attached, so the model speaks the recommendation in the
// sommelier's own voice and never narrates inference internals.
const INFERENCE_GUIDANCE = ' The result includes an "inference" block. Present its recommendation naturally in your own sommelier voice as advice, not as a verified fact. The "explanation" lines are the reasons behind the suggestion and "claims" are the confirmed facts you may quote. Never state a wine, winery, vintage, price, award, or location as fact unless it appears in "claims" with a source. If "found" is false, say honestly that you cannot yet confidently recommend from confirmed data, ask one short clarifying question, or offer a nearby alternative. Never mention "inference", scenario names, claim kinds, RAG, retrieval, databases, answerability, or any internal mechanism.';

async function orchestrateKnowledge(question, options = {}) {
    const normalizedQuestion = normalizeQuestion(question);
    const language = normalizeLanguage(options.language) || null;
    const mode = resolveAnswerMode(options.answerMode);
    const policy = modePolicy(mode);
    const routeImpl = options.routeImpl || routeKnowledgeWithAnswerabilityGate;
    const constraints = Array.isArray(options.constraints) ? options.constraints : [];

    const retrieval = await routeImpl(normalizedQuestion, {
        language,
        // The mode's allowed levels constrain what the router may consult:
        // web is fully disabled for knowledge_only / knowledge_catalog, and
        // the router already honors forceWeb/freshness within allowWeb.
        allowWeb: policy.allowWeb,
        forceWeb: options.forceWeb === true,
        limit: options.limit || 8,
        allowCatalog: policy.allowCatalog,
        knownEntityNames: options.knownEntityNames,
        answerabilityModel: options.answerabilityModel,
    });

    const allowedLevels = new Set(policy.levels);
    const evidence = (retrieval.evidence || []).filter((item) => allowedLevels.has(item.level));
    const claims = annotateConflicts(buildClaimsFromEvidence(evidence), retrieval.conflicts || []).map(publicClaim);
    const freshness = summarizeFreshness(claims, retrieval.freshness_sensitive === true);
    const conflicts = (retrieval.conflicts || []).map((conflict) => ({
        key: conflict.key,
        values: conflict.values,
    }));

    // Useful Answer Recovery: when the literal answer is not supported, run
    // one deterministic recovery pass through the same router and surface the
    // closest supported facts/alternatives in a `recovery` block. Recovery
    // never flips `answerable` and never changes the literal `claims`
    // contract -- it is a separate, transparent addition the audit/benchmark
    // can inspect.
    const recovery = await attemptRecovery({
        question: normalizedQuestion,
        language,
        retrieval,
        discoveryRouter: routeImpl,
        evidence,
        conflicts: retrieval.conflicts,
        allowedLevels: policy.levels,
        allowCatalog: policy.allowCatalog,
        skipAnswerability: true,
    });
    const answerPolicy = recovery && recovery.applied
        ? {
              ...(retrieval.answer_policy || {}),
              final_instruction: recovery.final_instruction,
          }
        : (retrieval.answer_policy || null);

    // Phase 6 Wine Intelligence: gated by INTENT, not by answer_mode. Runs
    // whenever the question is a Phase 6 ask (pairing, recommendation,
    // comparison, route), so the audit path measures the same behavior the
    // live tool delivers. The explicit `no_inference` constraint suppresses it.
    const inference = await inferForQuestion(normalizedQuestion, {
        language,
        allowWeb: policy.allowWeb,
        allowCatalog: policy.allowCatalog,
        limit: options.limit || 8,
        suppress: constraints.includes('no_inference'),
    });
    const finalAnswerPolicy = inference && answerPolicy
        ? { ...answerPolicy, final_instruction: (answerPolicy.final_instruction || '') + INFERENCE_GUIDANCE }
        : answerPolicy;

    return {
        ok: true,
        question: normalizedQuestion,
        language: language || 'auto',
        answer_mode: mode,
        allowed_levels: policy.levels,
        found: retrieval.found === true,
        answerable: retrieval.answerable === true,
        answerability_reason: retrieval.answerabilityReason || null,
        used_levels: [...new Set(evidence.map((item) => item.level))],
        web_used: retrieval.web_used === true,
        web_reason: retrieval.web_reason || null,
        freshness,
        conflicts,
        claims,
        recovery,
        inference,
        narrative: buildNarrative(claims, { mode, conflicts, freshness, question: normalizedQuestion }),
        answer_policy: finalAnswerPolicy,
    };
}

module.exports = {
    orchestrateKnowledge,
    normalizeQuestion,
    normalizeLanguage,
    buildNarrative,
};
'use strict';
/* Analysis for LOOP B (quality), LOOP D (cost) and path latency. */
const fs = require('fs');
const path = require('path');

const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'loop-b-results.json'), 'utf8'));
const steps = d.results.flatMap((r) => (r.steps || []).map((s) => ({ ...s, id: r.id, category: r.category })));

// Gemini 2.5 Flash list price (USD / 1M tokens).
const IN_PER_M = 0.30;
const OUT_PER_M = 2.50;

function mean(xs) { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function r2(x) { return x == null ? null : Number(x.toFixed(2)); }
function r0(x) { return x == null ? null : Math.round(x); }

function scoreBlock(rows, side) {
    const g = rows.map((s) => s.judge?.[side]).filter(Boolean);
    return {
        n: g.length,
        quality: r2(mean(g.map((x) => x.quality))),
        factuality: r2(mean(g.map((x) => x.factuality))),
        relevance: r2(mean(g.map((x) => x.relevance))),
        naturalness: r2(mean(g.map((x) => x.naturalness))),
        mean_unverified_claims: r2(mean(g.map((x) => (x.unverified_specific_claims || []).length))),
        pct_with_unverified_claims: r2(100 * g.filter((x) => (x.unverified_specific_claims || []).length).length / (g.length || 1)),
        pct_attributes_to_named_producer: r2(100 * g.filter((x) => x.attributes_fact_to_named_producer).length / (g.length || 1)),
    };
}

function latency(rows) {
    return {
        direct_ms: r0(mean(rows.map((s) => s.direct?.latency_ms))),
        grounded_ms: r0(mean(rows.map((s) => s.grounded?.latency_ms))),
        grounded_retrieval_ms: r0(mean(rows.map((s) => s.grounded?.retrieval_ms))),
        grounded_generation_ms: r0(mean(rows.map((s) => s.grounded?.generation_ms))),
    };
}

function tokens(rows) {
    const dp = mean(rows.map((s) => s.direct?.usage?.prompt_tokens));
    const dout = mean(rows.map((s) => s.direct?.usage?.output_tokens));
    const gp = mean(rows.map((s) => s.grounded?.usage?.prompt_tokens));
    const gout = mean(rows.map((s) => s.grounded?.usage?.output_tokens));
    const cost = (p, o) => (p == null ? null : Number((((p * IN_PER_M) + (o * OUT_PER_M)) / 1e6).toFixed(6)));
    return {
        direct_prompt_tokens: r0(dp), direct_output_tokens: r0(dout), direct_cost_usd: cost(dp, dout),
        grounded_prompt_tokens: r0(gp), grounded_output_tokens: r0(gout), grounded_cost_usd: cost(gp, gout),
    };
}

const directRouted = steps.filter((s) => s.router?.path === 'DIRECT');
const groundedRouted = steps.filter((s) => s.router?.path === 'GROUNDED');

const out = {
    n_items: d.results.length,
    n_turns: steps.length,
    evidence_parity: {
        mean_judge_evidence_items: r2(mean(steps.map((s) => s.judge_evidence_count))),
        mean_judge_evidence_chars: r0(mean(steps.map((s) => s.judge_evidence_chars))),
        note: 'Judge saw the generator\'s full evidence array (Phase 0 fix). The old harness would have capped this at 8 items / 5,607 chars.',
    },
    ROUTER_CHOSE_DIRECT: {
        n_turns: directRouted.length,
        direct_answer: scoreBlock(directRouted, 'direct'),
        grounded_answer_counterfactual: scoreBlock(directRouted, 'grounded'),
        better_answer: directRouted.reduce((h, s) => { const k = s.judge?.better_answer || 'n/a'; h[k] = (h[k] || 0) + 1; return h; }, {}),
        retrieval_effect: directRouted.reduce((h, s) => { const k = s.judge?.retrieval_effect || 'n/a'; h[k] = (h[k] || 0) + 1; return h; }, {}),
        judge_says_grounding_necessary: directRouted.filter((s) => s.judge?.grounding_necessary).length,
        judge_verdict: directRouted.reduce((h, s) => { const k = s.judge?.verdict || 'n/a'; h[k] = (h[k] || 0) + 1; return h; }, {}),
        latency: latency(directRouted),
        tokens: tokens(directRouted),
    },
    ROUTER_CHOSE_GROUNDED: {
        n_turns: groundedRouted.length,
        direct_answer_counterfactual: scoreBlock(groundedRouted, 'direct'),
        grounded_answer: scoreBlock(groundedRouted, 'grounded'),
        better_answer: groundedRouted.reduce((h, s) => { const k = s.judge?.better_answer || 'n/a'; h[k] = (h[k] || 0) + 1; return h; }, {}),
        judge_says_grounding_necessary: groundedRouted.filter((s) => s.judge?.grounding_necessary).length,
        latency: latency(groundedRouted),
        tokens: tokens(groundedRouted),
    },
    ALL_TURNS: { latency: latency(steps), tokens: tokens(steps) },
    // Cases where the judge disagrees with a DIRECT routing decision.
    direct_disputed_by_judge: directRouted
        .filter((s) => s.judge?.grounding_necessary || s.judge?.verdict === 'GROUNDING_REQUIRED' || s.judge?.better_answer === 'grounded')
        .map((s) => ({
            id: s.id, category: s.category, question: s.question, reason: s.router.reason,
            verdict: s.judge?.verdict, better: s.judge?.better_answer,
            direct_factuality: s.judge?.direct?.factuality, grounded_factuality: s.judge?.grounded?.factuality,
            direct_attributes: s.judge?.direct?.attributes_fact_to_named_producer,
            direct_unverified: s.judge?.direct?.unverified_specific_claims,
            explanation: s.judge?.explanation,
        })),
};

// LOOP D -- cost per 100 conversations at the measured DIRECT rate.
const DIRECT_RATE = 0.284; // combined offline eval
const TURNS_PER_CONV = 6;
const dc = out.ALL_TURNS.tokens;
const costDirect = ((dc.direct_prompt_tokens * IN_PER_M) + (dc.direct_output_tokens * OUT_PER_M)) / 1e6;
const costGrounded = ((dc.grounded_prompt_tokens * IN_PER_M) + (dc.grounded_output_tokens * OUT_PER_M)) / 1e6;
const turns100 = 100 * TURNS_PER_CONV;
out.LOOP_D_COST = {
    assumptions: { model: 'gemini-2.5-flash', usd_per_1m_input: IN_PER_M, usd_per_1m_output: OUT_PER_M, turns_per_conversation: TURNS_PER_CONV, direct_rate: DIRECT_RATE },
    cost_per_turn_direct_usd: Number(costDirect.toFixed(6)),
    cost_per_turn_grounded_usd: Number(costGrounded.toFixed(6)),
    current_all_grounded_per_100_conv_usd: Number((turns100 * costGrounded).toFixed(2)),
    selective_per_100_conv_usd: Number((turns100 * ((DIRECT_RATE * costDirect) + ((1 - DIRECT_RATE) * costGrounded))).toFixed(2)),
};
out.LOOP_D_COST.savings_pct = Number((100 * (1 - (out.LOOP_D_COST.selective_per_100_conv_usd / out.LOOP_D_COST.current_all_grounded_per_100_conv_usd))).toFixed(1));

fs.writeFileSync(path.join(__dirname, 'loop-b-analysis.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

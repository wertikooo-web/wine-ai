'use strict';
/*
 * LOOP A (classification accuracy) + LOOP C (router decision latency) +
 * weighted error scoring, for src/knowledge/selectiveRagRouter.js.
 *
 * Pure function evaluation -- no API calls, no DB, no network.
 *
 * Two datasets:
 *   - experiments/adaptive-routing/dataset.json (110 items / 118 turns),
 *     labelled by the prior sprint with prior = DIRECT_OK | AMBIGUOUS |
 *     GROUNDING_REQUIRED. Left untouched; only read here.
 *   - experiments/selective-routing/router-dataset.json (this sprint, 80 items).
 *
 * Scoring rules:
 *   - expected DIRECT   + got GROUNDED -> FALSE_GROUNDED (costs latency only)
 *   - expected GROUNDED + got DIRECT   -> FALSE_DIRECT   (the dangerous class)
 *   - expected AMBIGUOUS: GROUNDED is correct (the brief requires ambiguity to
 *     resolve toward GROUNDED); DIRECT is a FALSE_DIRECT.
 *
 * Weighted error (brief's severity model):
 *   FALSE_DIRECT on a high-severity item (entity/product/price/availability/
 *   unknown winery)  = 10
 *   FALSE_DIRECT on a low-severity item                     = 10 (still a
 *     wrong skip, but these items are labelled low because the consequence is
 *     mild; kept at 10 so no false DIRECT is ever cheap -- see note below)
 *   FALSE_GROUNDED on a general-knowledge item              = 2
 */

const fs = require('fs');
const path = require('path');
const { routeSelective } = require('../../src/knowledge/selectiveRagRouter');
const { classifyQueryIntent } = require('../../src/knowledge/layeredRouter');

const OUT = path.join(__dirname, 'offline-eval-results.json');

const SEV_FALSE_DIRECT = 10;
const SEV_FALSE_GROUNDED = 2;

function normExpected(label) {
    if (label === 'DIRECT_OK' || label === 'DIRECT') return 'DIRECT';
    if (label === 'GROUNDING_REQUIRED' || label === 'GROUNDED') return 'GROUNDED';
    return 'AMBIGUOUS';
}

// Flatten a dataset item into one or more evaluable turns. Multi-turn items
// carry the preceding turns as recentTurns so CONVERSATION_ENTITY_CONTEXT is
// exercised the way it would be in the live session.
// Only the FINAL turn of a multi-turn item is scored. The item's label
// describes the item's point, which lives in the last turn; earlier turns are
// context and are replayed into recentTurns, not graded against a label they
// were never written for.
function toTurns(item) {
    const turns = item.turns || [item.text];
    return turns.map((text, i) => ({
        id: turns.length > 1 ? `${item.id}.t${i + 1}` : item.id,
        item_id: item.id,
        category: item.category || item.class,
        lang: item.lang,
        text,
        turn_index: i,
        is_last_turn: i === turns.length - 1,
        // The label on a multi-turn item describes the item's point, which is
        // the FINAL turn. Earlier turns are context; they are still scored, but
        // against their own obvious label where the dataset gives one.
        expected: normExpected(item.expected || item.prior),
        severity_class: item.severity_class || null,
        recentTurns: turns.slice(0, i).flatMap((t) => [{ role: 'user', text: t }]),
    })).filter((t) => t.is_last_turn);
}

// Baselines -------------------------------------------------------------
// (a) always GROUNDED = today's de facto behaviour.
function baselineAlwaysGrounded() { return 'GROUNDED'; }
// (b) classifyQueryIntent() alone: the only pre-retrieval signal that exists
//     today. Its 'off_topic_smalltalk' tier is the sole case where nothing
//     would be looked up; everything else routes into retrieval.
function baselineIntentOnly(text) {
    const intent = classifyQueryIntent(text);
    return intent === 'off_topic_smalltalk' ? 'DIRECT' : 'GROUNDED';
}

function classify(expected, got) {
    if (expected === 'AMBIGUOUS') return got === 'GROUNDED' ? 'CORRECT' : 'FALSE_DIRECT';
    if (expected === got) return 'CORRECT';
    return expected === 'GROUNDED' ? 'FALSE_DIRECT' : 'FALSE_GROUNDED';
}

function score(rows, key) {
    const agg = { n: rows.length, correct: 0, false_direct: 0, false_grounded: 0, weighted: 0 };
    const byCat = {};
    for (const r of rows) {
        const outcome = classify(r.expected, r[key]);
        const cat = (byCat[r.category] ||= { n: 0, correct: 0, false_direct: 0, false_grounded: 0 });
        cat.n += 1;
        if (outcome === 'CORRECT') { agg.correct += 1; cat.correct += 1; }
        else if (outcome === 'FALSE_DIRECT') { agg.false_direct += 1; cat.false_direct += 1; agg.weighted += SEV_FALSE_DIRECT; }
        else { agg.false_grounded += 1; cat.false_grounded += 1; agg.weighted += SEV_FALSE_GROUNDED; }
    }
    agg.accuracy_pct = Number(((100 * agg.correct) / (agg.n || 1)).toFixed(1));
    agg.by_category = byCat;
    return agg;
}

function loadRows() {
    const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'adaptive-routing', 'dataset.json'), 'utf8'));
    const router = JSON.parse(fs.readFileSync(path.join(__dirname, 'router-dataset.json'), 'utf8'));
    return {
        legacy: legacy.questions.flatMap(toTurns),
        router: router.questions.flatMap(toTurns),
    };
}

function runSet(rows) {
    for (const r of rows) {
        const d = routeSelective(r.text, { recentTurns: r.recentTurns });
        r.router = d.path;
        r.router_reason = d.reason;
        r.router_entity = d.entity;
        r.router_confidence = d.confidence;
        r.always_grounded = baselineAlwaysGrounded();
        r.intent_only = baselineIntentOnly(r.text);
        r.outcome = classify(r.expected, r.router);
    }
    return {
        router: score(rows, 'router'),
        baseline_always_grounded: score(rows, 'always_grounded'),
        baseline_intent_only: score(rows, 'intent_only'),
        direct_rate_pct: Number(((100 * rows.filter((r) => r.router === 'DIRECT').length) / (rows.length || 1)).toFixed(1)),
        reason_histogram: rows.reduce((h, r) => { h[r.router_reason] = (h[r.router_reason] || 0) + 1; return h; }, {}),
        errors: rows.filter((r) => r.outcome !== 'CORRECT').map((r) => ({
            id: r.id, category: r.category, expected: r.expected, got: r.router,
            outcome: r.outcome, reason: r.router_reason, text: r.text,
        })),
    };
}

// LOOP C -- router decision latency, measured in isolation.
function measureLatency(rows, iterations = 200) {
    const samples = [];
    // warm-up (JIT + registry lazy load)
    for (const r of rows) routeSelective(r.text, { recentTurns: r.recentTurns });
    for (let i = 0; i < iterations; i += 1) {
        for (const r of rows) {
            const t = process.hrtime.bigint();
            routeSelective(r.text, { recentTurns: r.recentTurns });
            samples.push(Number(process.hrtime.bigint() - t) / 1e6);
        }
    }
    samples.sort((a, b) => a - b);
    const pick = (p) => Number(samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(4));
    return {
        n_calls: samples.length,
        mean_ms: Number((samples.reduce((s, v) => s + v, 0) / samples.length).toFixed(4)),
        p50_ms: pick(0.5), p95_ms: pick(0.95), p99_ms: pick(0.99),
        max_ms: Number(samples[samples.length - 1].toFixed(4)),
    };
}

function main() {
    const { legacy, router } = loadRows();
    const combined = [...legacy, ...router];
    const out = {
        meta: { generated: new Date().toISOString(), severity: { false_direct: SEV_FALSE_DIRECT, false_grounded: SEV_FALSE_GROUNDED } },
        legacy_110: runSet(legacy),
        router_80: runSet(router),
        combined: runSet(combined),
        latency_loop_c: measureLatency(combined),
        per_turn: combined.map((r) => ({
            id: r.id, dataset: legacy.includes(r) ? 'legacy' : 'router',
            category: r.category, lang: r.lang, text: r.text,
            expected: r.expected, router: r.router, reason: r.router_reason,
            entity: r.router_entity, confidence: r.router_confidence, outcome: r.outcome,
        })),
    };
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

    const line = (label, s) => console.log(
        `${label.padEnd(34)} n=${String(s.n).padStart(3)}  acc=${String(s.accuracy_pct).padStart(5)}%  falseDIRECT=${String(s.false_direct).padStart(3)}  falseGROUNDED=${String(s.false_grounded).padStart(3)}  weighted=${s.weighted}`,
    );
    for (const set of ['legacy_110', 'router_80', 'combined']) {
        console.log(`\n===== ${set} =====`);
        line('selectiveRagRouter', out[set].router);
        line('baseline: always GROUNDED', out[set].baseline_always_grounded);
        line('baseline: classifyQueryIntent', out[set].baseline_intent_only);
        console.log(`DIRECT rate (router): ${out[set].direct_rate_pct}%`);
        if (out[set].router.false_direct) {
            console.log('FALSE DIRECTS:');
            for (const e of out[set].errors.filter((e) => e.outcome === 'FALSE_DIRECT')) {
                console.log(`  [${e.id}] (${e.category}) ${e.reason} :: ${e.text}`);
            }
        }
    }
    console.log('\n--- per-category (combined, router) ---');
    for (const [cat, c] of Object.entries(out.combined.router.by_category).sort()) {
        console.log(`  ${cat.padEnd(28)} n=${String(c.n).padStart(3)} correct=${String(c.correct).padStart(3)} fD=${c.false_direct} fG=${c.false_grounded}`);
    }
    console.log('\n--- LOOP C router decision latency ---');
    console.log(JSON.stringify(out.latency_loop_c));
    console.log(`\nwrote ${OUT}`);
}

main();

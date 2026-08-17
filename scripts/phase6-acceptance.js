'use strict';

// Phase 6 Wine Intelligence acceptance harness.
//
// Same audit path as the live realtime tool: answerAudit.runAnswerAudit →
// orchestrateKnowledge → routeKnowledgeWithAnswerabilityGate (production
// default knowledge_web mode), so this measures the exact behavior the
// ordinary user gets on a recommendation/pairing/comparison/route ask.
//
//   npm run acceptance:phase6
//   npm run acceptance:phase6 -- --out benchmark-results/phase6.json
//   AUDIT_BASE_URL=https://wine-ai-realtime-production.up.railway.app node scripts/phase6-acceptance.js
//
// Exit code 0 only when every acceptance gate is green:
//   - intent_attachment_rate >= 0.9        (Phase 6 intents attach the inference block)
//   - recommendation_success_rate >= 0.8   (found:true intents resolve a recommendation)
//   - hard_constraint violations === 0     (recommended colour matches the ask)
//   - unsupported claims === 0             (no unprovenanced factual claim in inference)
//   - honesty failures === 0               (found:false always states what is missing)
//   - negative controls stay untouched     (factual turns never attach inference)
//   - no_inference constraint honored      (explicit suppression works)
//   - internal-language violations === 0   (voice-safe explanations)

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const DATASET_FILE = path.join(__dirname, '..', 'tests', 'benchmark', 'phase6-dataset.json');
const DEFAULT_OUT = path.join(__dirname, '..', 'benchmark-results', `phase6-${new Date().toISOString().slice(0, 10)}.json`);

const FACTUAL_KINDS = new Set(['verified_fact', 'live_catalog_fact', 'document_supported_fact', 'current_web_fact']);

const FORBIDDEN_RU = /(баз(?:а|е|ы|у)\s+данных|в\s+моей\s+базе|моей\s+базе|\bэндпоинт|\bретривер|\bретриевал|поисков(?:ая|ый|ое)\s+систем|answerability|\bRAG\b|\bкорпус|\bградер\b|\bгейт\b)/iu;
const FORBIDDEN_EN = /(\brag\b|\bretriev[a-z]*\b|answerabilit|corpus|endpoint|web[\s-]?search|internal\s+tool|\bdatabase\b)/iu;

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(Number(value || 0) * factor) / factor;
}

function loadDataset() {
    const raw = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));
    if (!Array.isArray(raw.questions) || !raw.questions.length) throw new Error('empty dataset');
    return raw;
}

async function runLocally(dataset) {
    const { runAnswerAudit } = require('../src/knowledge/answerAudit');
    const results = [];
    for (const q of dataset.questions) {
        const record = await runAnswerAudit({
            question: q.question,
            language: q.language,
            modes: q.answer_mode ? [q.answer_mode] : null,
            constraints: q.constraints || null,
        });
        const modeResult = record.results[0] || {};
        results.push({ row: q, modeResult });
    }
    return results;
}

async function runViaHttp(dataset, baseUrl) {
    const results = [];
    for (const q of dataset.questions) {
        const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/knowledge/audit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                question: q.question,
                language: q.language,
                modes: q.answer_mode ? [q.answer_mode] : undefined,
                constraints: q.constraints || undefined,
                save: false,
            }),
        });
        if (!response.ok) throw new Error(`audit HTTP ${response.status} for "${q.question}"`);
        const body = await response.json();
        const modeResult = (body.audit || body.case || {}).results?.[0] || {};
        results.push({ row: q, modeResult });
    }
    return results;
}

function inferenceColorOf(style) {
    // style is "Wine Name · red" -- the trailing token is the colour when known.
    const idx = String(style || '').lastIndexOf(' · ');
    return idx >= 0 ? String(style).slice(idx + 3).trim().toLocaleLowerCase() : null;
}

function unsupportedInferenceClaims(inference) {
    const defects = [];
    for (const claim of (inference && inference.claims) || []) {
        if (!FACTUAL_KINDS.has(claim.kind)) continue;
        const source = claim.source || {};
        if (!(source.url || source.title || source.document_page || source.chunk_id || source.verified_at || source.checked_at)) {
            defects.push({ claim: String(claim.claim || '').slice(0, 160), reason: 'missing_provenance' });
        }
        if (claim.kind === 'verified_fact') {
            defects.push({ claim: String(claim.claim || '').slice(0, 160), reason: 'ai_conclusion_marked_verified_fact' });
        }
    }
    return defects;
}

function internalLanguageViolations(modeResult) {
    const inference = modeResult.inference;
    const explanation = String((inference && inference.explanation || []).join('\n'));
    const claimText = String((inference && inference.claims || []).map((c) => c.claim).join('\n'));
    const text = `${explanation}\n${claimText}`;
    const ru = FORBIDDEN_RU.test(text) ? ['ru_marker'] : [];
    const en = FORBIDDEN_EN.test(text) ? ['en_marker'] : [];
    return [...ru, ...en];
}

function evaluateRow({ row, modeResult }) {
    const expected = row.expected || {};
    const inference = modeResult.inference || null;
    const checks = [];
    const passExplain = [];

    const violations = internalLanguageViolations(modeResult);
    checks.push({ name: 'no_internal_language', ok: violations.length === 0, got: violations.length || undefined });

    const defects = unsupportedInferenceClaims(inference);
    checks.push({ name: 'unsupported_claims_clean', ok: defects.length === 0, got: defects.length || undefined });

    // One authoritative answer per turn: a Phase 6 inference turn must never
    // ALSO carry an applied Useful Recovery when the inference block IS the
    // answer (found:true) -- that would reframe it into a competing answer
    // (the verifier's recovery-vs-inference conflict). When the inference
    // honestly found nothing (found:false), recovery supplying the closest
    // supported facts is the "offer a nearby alternative" the guidance asks
    // for, not a conflict.
    if (expected.expects_inference === true) {
        const recoveryApplied = modeResult.recovery && modeResult.recovery.applied === true;
        const inferenceAuthoritative = !!inference && inference.found === true;
        const conflict = inferenceAuthoritative && recoveryApplied;
        checks.push({ name: 'no_recovery_inference_conflict', ok: !conflict, got: conflict ? modeResult.recovery.strategy : 'none' });
    }

    if (expected.expects_inference === true) {
        const attached = !!inference && inference.scenario === expected.intent;
        checks.push({ name: 'intent_attached', ok: attached, got: inference ? inference.scenario : 'no_inference' });
        if (attached) passExplain.push(inference.scenario);

        if (expected.found === true) {
            checks.push({ name: 'found', ok: !!inference && inference.found === true, got: inference ? inference.found : 'no_inference' });
            if (expected.hard && expected.hard.color) {
                const wines = (inference.inference && inference.inference.wines) || [];
                const knownColor = wines.map((w) => ({ name: w.name, color: inferenceColorOf(w.style) })).filter((w) => w.color);
                const violationsNow = knownColor.filter((w) => w.color !== expected.hard.color);
                checks.push({
                    name: `hard_color_${expected.hard.color}`,
                    ok: knownColor.length > 0 && violationsNow.length === 0,
                    got: knownColor.map((w) => `${w.name}:${w.color}`).join(' | ') || 'no_known_color',
                });
            }
            if (expected.intent === 'compare_wines') {
                // Comparison with zero supported data must never be reported as
                // a confident "found" comparison (verifier: fabricated table).
                const rows = (inference.inference && inference.inference.attributes) || [];
                const bothKnown = rows.filter((r) => r.a !== '—' && r.b !== '—').length;
                const eitherKnown = rows.filter((r) => r.a !== '—' || r.b !== '—').length;
                checks.push({ name: 'compare_has_supported_data', ok: eitherKnown >= 1 && bothKnown >= 1, got: `either=${eitherKnown},both=${bothKnown}` });
            }
            if (expected.intent === 'recommend_wine') {
                // Every recommended "wine" must actually be a grounded bottle:
                // an official profile, a produces-relation wine, or a catalog
                // row carrying a wine signal (price/vintage/entity). A catalog
                // editorial headline must never be recommended as a wine.
                const wines = (inference.inference && inference.inference.wines) || [];
                const ungrounded = wines.filter((w) => !(w.grapes && w.grapes.length) && w.price == null && !w.producer && !(w.region && w.region.length));
                checks.push({
                    name: 'recommended_names_grounded',
                    ok: ungrounded.length === 0,
                    got: ungrounded.map((w) => w.name).join(' | ') || 'all_grounded',
                });
            }
        } else if (expected.found === 'either') {
            if (inference && inference.found === true) {
                checks.push({ name: 'honesty', ok: true, got: 'found' });
            } else {
                const missing = ((inference && inference.missing) || []).filter((m) => String(m).trim()).length;
                checks.push({ name: 'honesty', ok: missing > 0, got: `not_found,missing=${missing}` });
                if (missing > 0) passExplain.push('honest_not_found');
            }
        }
    } else {
        // Negative control: no inference block, and (when the row demands it)
        // the explicit no_inference constraint also suppresses the ai_inference claim.
        const noInferenceAttached = !inference;
        checks.push({ name: 'negative_control', ok: noInferenceAttached, got: inference ? inference.scenario : 'no_inference' });
        if (expected.no_inference_constraint === true) {
            const hasAiClaim = (modeResult.claims || []).some((c) => c.kind === 'ai_inference');
            checks.push({ name: 'no_inference_constraint', ok: !hasAiClaim, got: hasAiClaim ? 'ai_inference_claim_present' : 'none' });
        }
    }

    return {
        id: row.id,
        category: row.category,
        language: row.language,
        question: row.question,
        intent: row.intent || null,
        scenario: inference ? inference.scenario : null,
        found: inference ? inference.found : null,
        missing: inference ? inference.missing : [],
        recommendations: (inference && inference.inference && inference.inference.wines || [])
            .map((w) => ({ name: w.name, style: w.style, price: w.price })),
        pass: checks.every((c) => c.ok),
        passExplain,
        checks,
    };
}

function summarize(rows) {
    const intentRows = rows.filter((r) => r.row.expected?.expects_inference === true);
    const attached = intentRows.filter((r) => r.evaluate.scenario === r.row.intent);
    const successRows = intentRows.filter((r) => r.row.expected?.found === true);
    const succeeded = successRows.filter((r) => r.evaluate.found === true);
    const honestyFailures = intentRows.filter((r) => r.row.expected?.found === 'either' && r.evaluate.found === false
        && !r.evaluate.missing.some((m) => String(m).trim()));
    const hardFailures = rows.filter((r) => r.evaluate.checks.some((c) => /^hard_color_/.test(c.name) && !c.ok));
    const unsupported = rows.filter((r) => r.evaluate.checks.some((c) => c.name === 'unsupported_claims_clean' && !c.ok));
    const internal = rows.filter((r) => r.evaluate.checks.some((c) => c.name === 'no_internal_language' && !c.ok));
    const negatives = rows.filter((r) => r.row.expected?.expects_inference === false && r.row.expected?.no_inference_constraint !== true);
    const negativeFailures = negatives.filter((r) => r.evaluate.checks.some((c) => c.name === 'negative_control' && !c.ok));
    const noInferenceRows = rows.filter((r) => r.row.expected?.no_inference_constraint === true);
    const noInferenceFailures = noInferenceRows.filter((r) => r.evaluate.checks.some((c) => c.name === 'no_inference_constraint' && !c.ok));
    // Blocker regressions surfaced by the independent verifier.
    const recoveryConflicts = intentRows.filter((r) => r.evaluate.checks.some((c) => c.name === 'no_recovery_inference_conflict' && !c.ok));
    const compareDataFailures = rows.filter((r) => r.evaluate.checks.some((c) => c.name === 'compare_has_supported_data' && !c.ok));
    const ungroundedWineFailures = rows.filter((r) => r.evaluate.checks.some((c) => c.name === 'recommended_names_grounded' && !c.ok));

    return {
        total_rows: rows.length,
        intent_rows: intentRows.length,
        attached_intent_rows: attached.length,
        found_success_rows: successRows.length,
        succeeded_rows: succeeded.length,
        honesty_failures: honestyFailures.length,
        hard_constraint_violations: hardFailures.length,
        unsupported_claim_violations: unsupported.length,
        internal_language_violations: internal.length,
        negative_control_failures: negativeFailures.length,
        no_inference_failures: noInferenceFailures.length,
        recovery_inference_conflicts: recoveryConflicts.length,
        compare_data_failures: compareDataFailures.length,
        ungrounded_wine_failures: ungroundedWineFailures.length,
        intent_attachment_rate: intentRows.length ? round(attached.length / intentRows.length) : null,
        recommendation_success_rate: successRows.length ? round(succeeded.length / successRows.length) : null,
        by_category: rows.reduce((acc, r) => {
            acc[r.row.category] = acc[r.row.category] || { total: 0, passed: 0 };
            acc[r.row.category].total += 1;
            if (r.evaluate.pass) acc[r.row.category].passed += 1;
            return acc;
        }, {}),
    };
}

function gatePassed(s) {
    return [
        { name: `intent_attachment_rate >= 0.9 (${round(s.intent_attachment_rate)})`, ok: (s.intent_attachment_rate ?? 0) >= 0.9 },
        { name: `recommendation_success_rate >= 0.8 (${round(s.recommendation_success_rate)})`, ok: (s.recommendation_success_rate ?? 0) >= 0.8 },
        { name: 'no hard-constraint violations', ok: s.hard_constraint_violations === 0 },
        { name: 'no unsupported claims', ok: s.unsupported_claim_violations === 0 },
        { name: 'no honesty failures', ok: s.honesty_failures === 0 },
        { name: 'no negative-control failures', ok: s.negative_control_failures === 0 },
        { name: 'no_inference constraint honored', ok: s.no_inference_failures === 0 },
        { name: 'no internal-language violations', ok: s.internal_language_violations === 0 },
        { name: 'no recovery-inference conflicts', ok: s.recovery_inference_conflicts === 0 },
        { name: 'no zero-data comparison fabricated', ok: s.compare_data_failures === 0 },
        { name: 'no ungrounded recommended wine names', ok: s.ungrounded_wine_failures === 0 },
    ];
}

async function main() {
    const dataset = loadDataset();
    const args = process.argv.slice(2);
    const outIndex = args.indexOf('--out');
    const outFile = outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT;
    const baseUrl = process.env.AUDIT_BASE_URL;

    console.log(`Phase 6 Acceptance — ${dataset.questions.length} rows (${dataset.version})`);
    console.log(`Mode: ${baseUrl ? `HTTP → ${baseUrl}` : 'local (answerAudit.runAnswerAudit)'}`);
    console.log('');

    const startedAt = performance.now();
    const raw = baseUrl ? await runViaHttp(dataset, baseUrl) : await runLocally(dataset);
    const elapsedMs = performance.now() - startedAt;

    const evaluated = raw.map(({ row, modeResult }) => ({ row, modeResult, evaluate: evaluateRow({ row, modeResult }) }));
    const summary = summarize(evaluated);
    summary.elapsed_ms = round(elapsedMs);
    const gates = gatePassed(summary);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
        dataset_version: dataset.version,
        dataset_file: path.relative(process.cwd(), DATASET_FILE),
        summary,
        gates,
        rows: evaluated.map(({ row, modeResult, evaluate }) => ({
            id: evaluate.id,
            category: evaluate.category,
            language: evaluate.language,
            question: evaluate.question,
            pass: evaluate.pass,
            scenario: evaluate.scenario,
            found: evaluate.found,
            recommendations: evaluate.recommendations,
            missing: evaluate.missing,
            checks: evaluate.checks,
            pass_explain: evaluate.passExplain,
            answer_mode: modeResult.answer_mode,
        })),
    }, null, 2), 'utf8');

    console.log('─── SUMMARY ───');
    console.log(`rows:                       ${summary.total_rows}`);
    console.log(`intent rows:                ${summary.intent_rows}  (attached: ${summary.attached_intent_rows})`);
    console.log(`intent_attachment_rate:     ${summary.intent_attachment_rate}`);
    console.log(`recommendation_success_rate: ${summary.recommendation_success_rate}  (${summary.succeeded_rows}/${summary.found_success_rows})`);
    console.log(`hard-constraint violations: ${summary.hard_constraint_violations}`);
    console.log(`unsupported claims:         ${summary.unsupported_claim_violations}`);
    console.log(`honesty failures:           ${summary.honesty_failures}`);
    console.log(`negative-control failures:  ${summary.negative_control_failures}`);
    console.log(`no_inference failures:      ${summary.no_inference_failures}`);
    console.log(`internal-lang violations:   ${summary.internal_language_violations}`);
    console.log('');
    console.log('─── PER ROW ───');
    for (const r of evaluated) {
        const e = r.evaluate;
        const failed = e.checks.filter((c) => !c.ok);
        if (failed.length) {
            console.log(`✗ ${r.row.id} [${e.scenario || 'no-inference'} ${e.found === true ? 'found' : (e.found === false ? 'not_found' : '')}]`);
            for (const c of failed) console.log(`    ${c.name}: got=${JSON.stringify(c.got)}`);
        } else {
            const picks = e.recommendations.slice(0, 2).map((w) => `${w.name}${w.price != null ? ` (${w.price})` : ''}`).join(', ');
            console.log(`✓ ${r.row.id} [${e.scenario || 'negative'} ${e.found === true ? 'found' : (e.found === false ? 'honest_not_found' : 'no-inference')}]${picks ? ' → ' + picks : ''}`);
        }
    }
    console.log('');
    console.log('─── ACCEPTANCE GATE ───');
    const allOk = gates.every((g) => g.ok);
    for (const g of gates) console.log(`  ${g.ok ? 'ok ' : 'FAIL'} ${g.name}`);
    console.log('');
    console.log(`machine result:  ${path.relative(process.cwd(), outFile)}`);
    console.log(`elapsed:         ${summary.elapsed_ms}ms`);
    console.log(`RESULT: ${allOk ? 'PASS' : 'FAIL'}`);
    process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
    console.error('phase6 acceptance failed:', error.message);
    process.exit(1);
});

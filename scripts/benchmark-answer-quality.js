'use strict';

// Phase 2 answer-quality benchmark harness.
//
// Runs the reference RU/RO/EN dataset through the SAME /api/knowledge/audit
// path the admin screen uses (one orchestrator, one claim-provenance model),
// then prints a short human report AND writes a machine-readable JSON result
// next to the dataset. One command, repeatable:
//
//   npm run benchmark:quality
//   npm run benchmark:quality -- --out benchmark-results/quality.json
//   AUDIT_BASE_URL=https://wine-ai-realtime-production.up.railway.app node scripts/benchmark-answer-quality.js
//
// AUDIT_BASE_URL: run each question against a live HTTP audit endpoint
// (default: run locally through answerAudit.runAnswerAudit()).
//
// Exit code is 0 when the run completed and the machine result was written;
// the quality report itself is data, not a pass/fail assertion.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const DATASET_FILE = path.join(__dirname, '..', 'tests', 'benchmark', 'answer-quality-dataset.json');
const DEFAULT_OUT = path.join(__dirname, '..', 'benchmark-results', `answer-quality-${new Date().toISOString().slice(0, 10)}.json`);

function loadDataset() {
    const raw = JSON.parse(fs.readFileSync(DATASET_FILE, 'utf8'));
    if (!Array.isArray(raw.questions) || !raw.questions.length) throw new Error('empty dataset');
    return raw;
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
    return sorted[Math.max(0, index)];
}

function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(Number(value || 0) * factor) / factor;
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
        results.push({ row: q, record, modeResult });
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
        if (!response.ok) {
            throw new Error(`audit HTTP ${response.status} for "${q.question}"`);
        }
        const body = await response.json();
        const audit = body.audit || body.case || {};
        const modeResult = (audit.results || [])[0] || {};
        results.push({ row: q, record: audit, modeResult });
    }
    return results;
}

// Deterministic per-row verdict: does the run satisfy the dataset's expected
// contract for THIS row? (answerability, min claims, constraint compliance)
function rowPass(q, modeResult) {
    const metrics = modeResult.metrics || {};
    const checks = [];
    if (typeof q.expected?.answerable === 'boolean') {
        const ok = (modeResult.answerable === true) === q.expected.answerable;
        checks.push({ name: 'answerable', ok, got: modeResult.answerable, expected: q.expected.answerable });
    }
    if (Number.isFinite(q.expected?.min_claims)) {
        const count = (modeResult.claims || []).length;
        const ok = count >= q.expected.min_claims;
        checks.push({ name: 'min_claims', ok, got: count, expected: q.expected.min_claims });
    }
    if (q.expected?.constraint_compliant === true) {
        const ok = metrics.constraints?.compliant === true;
        checks.push({ name: 'constraint_compliant', ok, got: metrics.constraints?.compliant, expected: true });
    }
    return { ok: checks.length === 0 || checks.every((c) => c.ok), checks };
}

function summarize(results) {
    const perRow = results.map(({ row, record, modeResult }) => {
        const metrics = modeResult.metrics || {};
        const verdict = rowPass(row, modeResult);
        return {
            id: row.id,
            category: row.category,
            language: row.language,
            answer_mode: modeResult.answer_mode || row.answer_mode || 'default',
            pass: verdict.ok,
            checks: verdict.checks,
            answerable: modeResult.answerable === true,
            found: modeResult.found === true,
            claim_count: (modeResult.claims || []).length,
            provenance_coverage: metrics.provenance_coverage?.coverage ?? null,
            hallucination_risk: metrics.hallucination?.risk ?? null,
            hallucination_score: metrics.hallucination?.score ?? null,
            inference_count: metrics.inference_count ?? null,
            unresolved_count: metrics.unresolved_count ?? null,
            conflict_count: (modeResult.conflicts || []).length,
            constraint_compliant: metrics.constraints?.compliant ?? null,
            latency_ms: modeResult.latency_ms ?? null,
            narrative: (modeResult.narrative || '').slice(0, 240),
        };
    });

    const total = perRow.length;
    const passed = perRow.filter((r) => r.pass).length;
    const answerableRows = perRow.filter((r) => r.answerable);
    const latencies = perRow.map((r) => r.latency_ms || 0).sort((a, b) => a - b);
    const claimCounts = perRow.map((r) => r.claim_count);
    const coverageValues = perRow.filter((r) => r.provenance_coverage != null).map((r) => r.provenance_coverage);
    const highRisk = perRow.filter((r) => r.hallucination_risk === 'high').length;
    const mediumRisk = perRow.filter((r) => r.hallucination_risk === 'medium').length;
    const constraintsRows = perRow.filter((r) => r.constraint_compliant != null);
    const constraintsOk = constraintsRows.filter((r) => r.constraint_compliant).length;

    const byCategory = {};
    for (const row of perRow) {
        byCategory[row.category] = byCategory[row.category] || { total: 0, passed: 0 };
        byCategory[row.category].total += 1;
        if (row.pass) byCategory[row.category].passed += 1;
    }

    return {
        generated_at: new Date().toISOString(),
        total_rows: total,
        passed_rows: passed,
        pass_rate: round(passed / total),
        answerability: {
            answerable_rows: answerableRows.length,
            answerable_rate: round(answerableRows.length / total),
        },
        claims: {
            total_claims: claimCounts.reduce((s, n) => s + n, 0),
            avg_claims_per_row: round(claimCounts.reduce((s, n) => s + n, 0) / total),
        },
        provenance: {
            rows_with_coverage: coverageValues.length,
            avg_provenance_coverage: coverageValues.length ? round(coverageValues.reduce((s, v) => s + v, 0) / coverageValues.length) : null,
        },
        hallucination: {
            high_risk_rows: highRisk,
            medium_risk_rows: mediumRisk,
            low_or_none_rows: total - highRisk - mediumRisk,
            high_risk_rate: round(highRisk / total),
        },
        conflicts: {
            rows_with_conflicts: perRow.filter((r) => r.conflict_count > 0).length,
            total_unresolved_claims: perRow.reduce((s, r) => s + (r.unresolved_count || 0), 0),
        },
        constraints: {
            rows_with_constraints: constraintsRows.length,
            constraints_compliant_rows: constraintsOk,
            constraint_compliance_rate: constraintsRows.length ? round(constraintsOk / constraintsRows.length) : null,
        },
        latency: {
            avg_ms: round(latencies.reduce((s, l) => s + l, 0) / latencies.length),
            p50_ms: round(percentile(latencies, 0.5)),
            p95_ms: round(percentile(latencies, 0.95)),
            max_ms: latencies.length ? Math.round(latencies[latencies.length - 1]) : 0,
        },
        by_category: byCategory,
        by_language: {
            ru: perRow.filter((r) => r.language === 'ru').length,
            ro: perRow.filter((r) => r.language === 'ro').length,
            en: perRow.filter((r) => r.language === 'en').length,
        },
    };
}

async function main() {
    const dataset = loadDataset();
    const args = process.argv.slice(2);
    const outIndex = args.indexOf('--out');
    const outFile = outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT;
    const baseUrl = process.env.AUDIT_BASE_URL;

    console.log(`Answer Quality Benchmark — ${dataset.questions.length} questions (${dataset.version})`);
    console.log(`Mode: ${baseUrl ? `HTTP → ${baseUrl}` : 'local (answerAudit.runAnswerAudit)'}`);
    console.log('');

    const startedAt = performance.now();
    const results = baseUrl ? await runViaHttp(dataset, baseUrl) : await runLocally(dataset);
    const elapsedMs = performance.now() - startedAt;

    const summary = summarize(results);
    summary.elapsed_ms = round(elapsedMs);

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const report = {
        dataset_version: dataset.version,
        dataset_file: path.relative(process.cwd(), DATASET_FILE),
        summary,
        rows: results.map(({ row, modeResult }) => ({
            id: row.id,
            category: row.category,
            language: row.language,
            question: row.question,
            answer_mode: modeResult.answer_mode || null,
            found: modeResult.found === true,
            answerable: modeResult.answerable === true,
            used_levels: modeResult.used_levels || [],
            web_used: modeResult.web_used === true,
            claim_count: (modeResult.claims || []).length,
            latency_ms: modeResult.latency_ms ?? null,
            metrics: modeResult.metrics || {},
            narrative: (modeResult.narrative || '').slice(0, 500),
        })),
    };
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

    // ---- short human report ----
    const s = summary;
    console.log('─── SUMMARY ───');
    console.log(`rows:            ${s.total_rows}  (RU ${s.by_language.ru} / RO ${s.by_language.ro} / EN ${s.by_language.en})`);
    console.log(`pass rate:       ${s.pass_rate}  (${s.passed_rows}/${s.total_rows})`);
    console.log(`answerability:   ${s.answerability.answerable_rate}  (${s.answerability.answerable_rows}/${s.total_rows})`);
    console.log(`avg claims/row:  ${s.claims.avg_claims_per_row}`);
    console.log(`provenance cov:  ${s.provenance.avg_provenance_coverage ?? 'n/a'}`);
    console.log(`hallucination:   high ${s.hallucination.high_risk_rows} / medium ${s.hallucination.medium_risk_rows} / low-none ${s.hallucination.low_or_none_rows}`);
    console.log(`conflicts:       rows ${s.conflicts.rows_with_conflicts}, unresolved claims ${s.conflicts.total_unresolved_claims}`);
    console.log(`constraints:     ${s.constraints.constraint_compliance_rate ?? 'n/a'}  (${s.constraints.constraints_compliant_rows}/${s.constraints.rows_with_constraints})`);
    console.log(`latency:         avg ${s.latency.avg_ms}ms  p95 ${s.latency.p95_ms}ms`);
    console.log('');
    console.log('─── BY CATEGORY ───');
    for (const [category, stat] of Object.entries(s.by_category)) {
        console.log(`  ${category.padEnd(22)} ${stat.passed}/${stat.total}  (${round(stat.passed / stat.total)})`);
    }
    console.log('');
    console.log(`machine result:  ${path.relative(process.cwd(), outFile)}`);
    console.log(`elapsed:         ${s.elapsed_ms}ms`);
    console.log('NOTE: this is a quality report, not a pass/fail gate.');
}

main().catch((error) => {
    console.error('benchmark failed:', error.message);
    process.exit(1);
});
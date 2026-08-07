'use strict';
const fs = require('fs');
const path = require('path');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results.json'), 'utf8'));
const ds = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
const byId = Object.fromEntries(ds.questions.map((q) => [q.id, q]));

const steps = [];
for (const r of data.results) {
    for (const s of (r.steps || [])) {
        if (!s.judge || s.judge.error || s.judge.skipped || s.judge.parse_error) continue;
        steps.push({ ...s, id: r.id, class: r.class, prior: r.prior, isFollowup: (byId[r.id]?.turns || []).length > 1, turn: s.turn });
    }
}
const n = steps.length;
const avg = (f) => (steps.reduce((a, s) => a + f(s), 0) / n).toFixed(2);
const med = (arr) => { const a = arr.filter((x) => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const mean = (arr) => { const a = arr.filter((x) => typeof x === 'number'); return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null; };
const pct = (k) => `${((k / n) * 100).toFixed(1)}%`;

console.log(`\n=== N (graded turns) = ${n}  (items=${data.results.length}) ===`);
const failed = data.results.flatMap((r) => (r.steps || []).filter((s) => s.judge?.error || s.judge?.skipped || s.judge?.parse_error).map((s) => `${r.id}/t${s.turn}: ${s.judge.error || s.judge.skipped || 'parse_error'}`));
if (failed.length) console.log('UNGRADED:', failed.join('; '));

console.log('\n=== SCORES (1-5) ===');
for (const m of ['quality', 'factuality', 'relevance', 'naturalness']) {
    console.log(`${m.padEnd(12)} direct=${avg((s) => s.judge.direct[m])}  rag=${avg((s) => s.judge.rag[m])}`);
}

console.log('\n=== LATENCY (ms) ===');
console.log('direct  mean', mean(steps.map((s) => s.direct.latency_ms)), ' median', med(steps.map((s) => s.direct.latency_ms)));
console.log('rag     mean', mean(steps.map((s) => s.rag.latency_ms)), ' median', med(steps.map((s) => s.rag.latency_ms)));
console.log('  rag retrieval mean', mean(steps.map((s) => s.rag.retrieval_ms)), ' median', med(steps.map((s) => s.rag.retrieval_ms)));
console.log('  rag generation mean', mean(steps.map((s) => s.rag.generation_ms)), ' median', med(steps.map((s) => s.rag.generation_ms)));

const tok = (c) => ({
    p: mean(steps.map((s) => s[c].usage?.prompt_tokens)),
    o: mean(steps.map((s) => s[c].usage?.output_tokens)),
});
console.log('\n=== TOKENS (mean per turn) ===');
console.log('direct prompt', tok('direct').p, 'output', tok('direct').o);
console.log('rag    prompt', tok('rag').p, 'output', tok('rag').o);

const D = 1; // meaningful delta on the 1-5 scale
const better = steps.filter((s) => s.judge.rag.quality - s.judge.direct.quality >= D || s.judge.rag.factuality - s.judge.direct.factuality >= D);
const worse = steps.filter((s) => s.judge.direct.quality - s.judge.rag.quality >= D || s.judge.direct.factuality - s.judge.rag.factuality >= D);
const bothWays = better.filter((s) => worse.includes(s));
console.log('\n=== RAG EFFECT (delta >= 1 on quality OR factuality) ===');
console.log(`improved: ${better.length} (${pct(better.length)})`);
console.log(`harmed:   ${worse.length} (${pct(worse.length)})`);
console.log(`mixed(both): ${bothWays.length}`);
console.log('judge retrieval_effect:', JSON.stringify(steps.reduce((a, s) => { a[s.judge.retrieval_effect] = (a[s.judge.retrieval_effect] || 0) + 1; return a; }, {})));
console.log('judge effect_kind:', JSON.stringify(steps.reduce((a, s) => { a[s.judge.retrieval_effect_kind] = (a[s.judge.retrieval_effect_kind] || 0) + 1; return a; }, {})));

const verdicts = steps.reduce((a, s) => { a[s.judge.verdict] = (a[s.judge.verdict] || 0) + 1; return a; }, {});
console.log('\n=== ROUTING DISTRIBUTION (judged) ===');
for (const k of ['DIRECT_SUFFICIENT', 'GROUNDING_REQUIRED', 'AMBIGUOUS']) console.log(`${k.padEnd(20)} ${verdicts[k] || 0} (${pct(verdicts[k] || 0)})`);
console.log('grounding_necessary=true:', steps.filter((s) => s.judge.grounding_necessary).length, pct(steps.filter((s) => s.judge.grounding_necessary).length));

console.log('\n=== PRIOR vs JUDGED ===');
const map = { DIRECT_OK: 'DIRECT_SUFFICIENT', GROUNDING_REQUIRED: 'GROUNDING_REQUIRED', AMBIGUOUS: 'AMBIGUOUS' };
const agree = steps.filter((s) => map[s.prior] === s.judge.verdict).length;
console.log(`agreement: ${agree}/${n} (${pct(agree)})`);
const diverged = steps.filter((s) => map[s.prior] !== s.judge.verdict);
console.log('diverged:');
for (const s of diverged) console.log(`  ${s.id}/t${s.turn} [${s.class}] prior=${s.prior} -> ${s.judge.verdict} :: ${s.question.slice(0, 70)}`);

console.log('\n=== BY CLASS (quality direct vs rag | verdict mix) ===');
const classes = [...new Set(steps.map((s) => s.class))];
for (const c of classes) {
    const g = steps.filter((s) => s.class === c);
    const a = (f) => (g.reduce((x, s) => x + f(s), 0) / g.length).toFixed(2);
    const v = g.reduce((acc, s) => { acc[s.judge.verdict] = (acc[s.judge.verdict] || 0) + 1; return acc; }, {});
    console.log(`${c.padEnd(26)} n=${String(g.length).padStart(3)} Q ${a((s) => s.judge.direct.quality)}->${a((s) => s.judge.rag.quality)}  F ${a((s) => s.judge.direct.factuality)}->${a((s) => s.judge.rag.factuality)}  ${JSON.stringify(v)}`);
}

console.log('\n=== DIRECT CONFIDENT-HALLUCINATION CASES ===');
const halluc = steps.filter((s) => (s.judge.direct.unverified_specific_claims || []).length > 0);
console.log(`count: ${halluc.length}/${n} (${pct(halluc.length)})`);
for (const s of halluc) {
    console.log(`\n- ${s.id}/t${s.turn} [${s.class}] "${s.question}"`);
    console.log(`  direct F=${s.judge.direct.factuality} Q=${s.judge.direct.quality} | rag F=${s.judge.rag.factuality} Q=${s.judge.rag.quality} | verdict=${s.judge.verdict}`);
    console.log(`  claims: ${(s.judge.direct.unverified_specific_claims || []).join(' ;; ')}`);
    console.log(`  direct: ${s.direct.answer.replace(/\s+/g, ' ').slice(0, 320)}`);
    console.log(`  ragEv: ${(s.rag.retrieval?.evidence || []).slice(0, 2).map((e) => e.title).join(' | ') || 'NONE'} (found=${s.rag.retrieval?.found} answerable=${s.rag.retrieval?.answerable} web=${s.rag.retrieval?.web_used})`);
    console.log(`  rag:    ${s.rag.answer.replace(/\s+/g, ' ').slice(0, 320)}`);
}

console.log('\n=== RAG HALLUCINATION CASES (for symmetry) ===');
const rh = steps.filter((s) => (s.judge.rag.unverified_specific_claims || []).length > 0);
console.log(`count: ${rh.length}/${n} (${pct(rh.length)})`);
for (const s of rh.slice(0, 15)) console.log(`- ${s.id}/t${s.turn}: ${(s.judge.rag.unverified_specific_claims || []).join(' ;; ').slice(0, 200)}`);

console.log('\n=== TOP RAG-HARM CASES ===');
for (const s of worse.sort((a, b) => (b.judge.direct.quality - b.judge.rag.quality) - (a.judge.direct.quality - a.judge.rag.quality)).slice(0, 12)) {
    console.log(`\n- ${s.id}/t${s.turn} [${s.class}] "${s.question}"`);
    console.log(`  Q ${s.judge.direct.quality}->${s.judge.rag.quality}  F ${s.judge.direct.factuality}->${s.judge.rag.factuality}  kind=${s.judge.retrieval_effect_kind}`);
    console.log(`  why: ${s.judge.retrieval_effect_explanation}`);
    console.log(`  retrieval: found=${s.rag.retrieval?.found} answerable=${s.rag.retrieval?.answerable} reason=${s.rag.retrieval?.answerability_reason} web=${s.rag.retrieval?.web_used} levels=${(s.rag.retrieval?.used_levels || []).join(',')}`);
    console.log(`  ev: ${(s.rag.retrieval?.evidence || []).slice(0, 3).map((e) => e.title).join(' | ')}`);
    console.log(`  rag: ${s.rag.answer.replace(/\s+/g, ' ').slice(0, 250)}`);
}

console.log('\n=== TOP RAG-HELP CASES ===');
for (const s of better.sort((a, b) => (b.judge.rag.quality - b.judge.direct.quality) - (a.judge.rag.quality - a.judge.direct.quality)).slice(0, 12)) {
    console.log(`\n- ${s.id}/t${s.turn} [${s.class}] "${s.question}"`);
    console.log(`  Q ${s.judge.direct.quality}->${s.judge.rag.quality}  F ${s.judge.direct.factuality}->${s.judge.rag.factuality}  kind=${s.judge.retrieval_effect_kind}`);
    console.log(`  why: ${s.judge.retrieval_effect_explanation}`);
    console.log(`  ev: ${(s.rag.retrieval?.evidence || []).slice(0, 3).map((e) => e.title).join(' | ')}`);
}

console.log('\n=== FOLLOW-UP (multi-turn) TURN 2 ===');
for (const s of steps.filter((x) => x.isFollowup && x.turn === 2)) {
    console.log(`- ${s.id} "${s.question.slice(0, 60)}" Q ${s.judge.direct.quality}->${s.judge.rag.quality} F ${s.judge.direct.factuality}->${s.judge.rag.factuality} verdict=${s.judge.verdict} effect=${s.judge.retrieval_effect_kind} directClaims=${(s.judge.direct.unverified_specific_claims || []).length}`);
}

console.log('\n=== RETRIEVAL HEALTH ===');
const found = steps.filter((s) => s.rag.retrieval?.found).length;
const ansTrue = steps.filter((s) => s.rag.retrieval?.answerable === true).length;
const ansFalse = steps.filter((s) => s.rag.retrieval?.answerable === false).length;
const ansNull = steps.filter((s) => s.rag.retrieval?.answerable === null).length;
const web = steps.filter((s) => s.rag.retrieval?.web_used).length;
console.log(`found=${found} (${pct(found)}) answerable_true=${ansTrue} (${pct(ansTrue)}) answerable_false=${ansFalse} answerable_null=${ansNull} web_used=${web} (${pct(web)})`);
const intents = {};
console.log('\n(intent classification is logged by the tool; see run stdout)');

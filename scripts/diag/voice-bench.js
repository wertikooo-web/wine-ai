'use strict';

// Voice benchmark: 60 scripted turns in 7 /lite conversations against
// production (scenarios: voice-bench-scenarios.js). The guest side is typed;
// the answer is the real voice model with tools, as guests hear it. Auto
// checks per turn: answer language, expected/forbidden content, required
// tools, spoken length, first-audio latency. Cost and "not from the catalog"
// flags come from the turn journal (/api/turns) for the same sessions.
// Read-only for the product. Costs roughly 1 EUR per full run.
//
//   ADMIN_TOKEN=... node scripts/diag/voice-bench.js
//   BENCH_GROUPS=language_switch,memory   only these groups
//   BENCH_OUT=/tmp/voice-bench.json       full results as JSON

const fs = require('fs');
const WS = require('ws');
const SCENARIOS = require('./voice-bench-scenarios');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const TOKEN = process.env.ADMIN_TOKEN || '';
const ONLY = String(process.env.BENCH_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SLOW_FIRST_AUDIO_MS = Number(process.env.BENCH_SLOW_MS || 8000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Answer language. Wine, grape and place names are Latin in every language,
// so Russian is decided by the share of Cyrillic letters and Romanian vs
// English by marker words / diacritics.
const RO_MARKERS = /[ăâîșțşţ]|\b(și|este|un|o|de|pentru|cu|mai|vin|vinul|foarte|care|poți|îți|recomand|bine|mulțumesc)\b/gi;
const EN_MARKERS = /\b(the|and|is|with|you|for|it|this|wine|of|to|a|would|try|great|your)\b/gi;
function answerLanguage(text) {
    const s = String(text || '');
    const letters = (s.match(/\p{L}/gu) || []).length;
    if (!letters) return null;
    const cyr = (s.match(/[а-яё]/giu) || []).length;
    if (cyr / letters > 0.5) return 'ru';
    const ro = (s.match(RO_MARKERS) || []).length;
    const en = (s.match(EN_MARKERS) || []).length;
    if (!ro && !en) return null;
    return ro >= en ? 'ro' : 'en';
}

async function http(pathname, options = {}) {
    const headers = { ...(options.headers || {}), ...(TOKEN ? { 'x-admin-token': TOKEN } : {}) };
    const res = await fetch(`${BASE_URL}${pathname}`, { ...options, headers });
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text) }; } catch { return { status: res.status, json: null }; }
}

function open(url) {
    return new Promise((resolve, reject) => {
        const ws = new WS(url, TOKEN ? { headers: { 'x-admin-token': TOKEN } } : undefined);
        const events = [];
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            try {
                const e = JSON.parse(data.toString());
                if (e.type === 'audio.chunk' || e.type === 'audio.delta') { if (!events.length || events[events.length - 1].type !== e.type) events.push({ at: Date.now(), type: e.type }); return; }
                events.push({ at: Date.now(), ...e });
            } catch { /* ignore */ }
        });
        ws.on('open', () => resolve({ ws, events, send: (p) => ws.send(JSON.stringify(p)) }));
        ws.on('error', reject);
    });
}

async function waitFor(events, predicate, timeoutMs, fromIndex = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = events.slice(fromIndex).find(predicate);
        if (hit) return hit;
        await sleep(50);
    }
    return null;
}

function checkTurn(turn, r) {
    const issues = [];
    if (!r.answer) { issues.push('no_answer'); return issues; }
    const lang = answerLanguage(r.answer);
    if (turn.lang && lang && lang !== turn.lang) issues.push(`language:${lang}!=${turn.lang}`);
    if (turn.expect && !turn.expect.test(r.answer)) issues.push(`missing:${turn.expect.source}`);
    if (turn.forbid && turn.forbid.test(r.answer)) issues.push(`forbidden:${turn.forbid.source}`);
    if (turn.tool && !r.tools.some((t) => new RegExp(`^(${turn.tool})$`).test(t))) issues.push(`no_tool:${turn.tool}`);
    for (const t of turn.noTool || []) if (r.tools.includes(t)) issues.push(`used:${t}`);
    const words = r.answer.split(/\s+/).filter(Boolean).length;
    if (words > (turn.maxWords || 70)) issues.push(`long:${words}w`);
    if (r.silenceMs != null && r.silenceMs > SLOW_FIRST_AUDIO_MS) issues.push(`slow:${r.silenceMs}ms`);
    return issues;
}

async function runGroup(group, age) {
    const conn = await open(`${WS_BASE}/realtime?channel=lite${age}`);
    const ready = await waitFor(conn.events, (e) => e.type === 'session.ready', 10000);
    conn.send({ type: 'session.start', sampleRate: 16000, language: group.language });
    await waitFor(conn.events, (e) => e.type === 'provider.ready', 20000);
    const sessionId = ready && ready.session_id;
    console.log(`\n=== ${group.group} (${group.turns.length} turns) session ${sessionId}`);
    const results = [];
    for (const [i, turn] of group.turns.entries()) {
        const from = conn.events.length;
        const t0 = Date.now();
        conn.send({ type: 'input_text.submit', text: turn.q });
        const end = await waitFor(conn.events, (e) => ['audio.end', 'response.failed'].includes(e.type), 45000, from);
        await sleep(400); // trailing transcript
        const slice = conn.events.slice(from);
        const firstAudio = slice.find((e) => e.type === 'audio.chunk' || e.type === 'audio.delta');
        const bridgeEv = slice.find((e) => e.type === 'assistant.bridge');
        const r = {
            group: group.group,
            n: i + 1,
            q: turn.q,
            end: end ? end.type : 'timeout',
            firstAudioMs: firstAudio ? firstAudio.at - t0 : null,
            // filler phrase ("one moment, let me check") played while a tool runs
            bridgeMs: bridgeEv ? bridgeEv.at - t0 : null,
            totalMs: Date.now() - t0,
            tools: slice.filter((e) => e.type === 'tool.call').map((e) => e.tool_name || e.name).filter(Boolean),
            answer: slice.filter((e) => e.type === 'transcript.model').map((e) => e.text).join('').replace(/\s+/g, ' ').trim(),
        };
        r.answerLanguage = answerLanguage(r.answer);
        // what the guest actually waits for: the first sound, filler or answer
        r.silenceMs = [r.firstAudioMs, r.bridgeMs].filter((x) => x != null).sort((a, b) => a - b)[0] ?? null;
        r.issues = checkTurn(turn, r);
        if (r.end !== 'audio.end') r.issues.unshift(r.end);
        results.push(r);
        console.log(`#${i + 1} ${r.issues.length ? 'FAIL ' + r.issues.join(' ') : 'ok'} | answer ${r.firstAudioMs ?? '-'}ms bridge ${r.bridgeMs ?? '-'}ms | [${r.tools.join(',')}] | ${r.answerLanguage || '?'}`);
        console.log(`  Q: ${turn.q}`);
        console.log(`  A: ${r.answer.slice(0, 400)}`);
        await sleep(800);
    }
    conn.ws.close();
    return { sessionId, results };
}

function pct(values, p) {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

async function main() {
    const groups = SCENARIOS.filter((g) => !ONLY.length || ONLY.includes(g.group));
    const age = await http('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    const av = age.json?.token ? `&av=${encodeURIComponent(age.json.token)}` : '';
    const runs = [];
    for (const group of groups) {
        try {
            runs.push(await runGroup(group, av));
        } catch (error) {
            console.log(`group ${group.group} failed: ${error.message}`);
            runs.push({ sessionId: null, results: group.turns.map((t, i) => ({ group: group.group, n: i + 1, q: t.q, issues: ['group_failed'] })) });
        }
    }

    // Journal: cost and "not from the catalog" flags for the same sessions.
    await sleep(4000);
    let costUsd = 0;
    const flagged = [];
    const toolMs = [];
    for (const run of runs.filter((x) => x.sessionId)) {
        const turns = await http(`/api/turns?session=${encodeURIComponent(run.sessionId)}&limit=50`);
        if (!turns.json || !turns.json.ok) continue;
        costUsd += Number(turns.json.cost_usd) || 0;
        for (const t of turns.json.turns) {
            for (const tool of t.tools || []) toolMs.push({ name: tool.name, ms: tool.ms, q: t.question });
            const names = t.flags && t.flags.unverified_names;
            if (names && names.length) flagged.push(`${t.question} -> ${names.join(', ')}`);
        }
    }

    const all = runs.flatMap((x) => x.results);
    const failed = all.filter((r) => r.issues.length);
    const byKind = {};
    for (const r of failed) for (const i of r.issues) { const k = i.split(':')[0]; byKind[k] = (byKind[k] || 0) + 1; }
    const fa = all.map((r) => r.firstAudioMs);
    const si = all.map((r) => r.silenceMs);
    console.log('\n================ SUMMARY ================');
    console.log(`turns=${all.length} passed=${all.length - failed.length} failed=${failed.length} score=${Math.round(((all.length - failed.length) / all.length) * 100)}%`);
    for (const g of groups) {
        const rs = all.filter((r) => r.group === g.group);
        console.log(`  ${g.group.padEnd(16)} ${rs.filter((r) => !r.issues.length).length}/${rs.length}`);
    }
    console.log(`issues by kind: ${JSON.stringify(byKind)}`);
    console.log(`first answer audio: p50=${pct(fa, 50)}ms p90=${pct(fa, 90)}ms max=${pct(fa, 100)}ms`);
    console.log(`silence (first sound incl. filler): p50=${pct(si, 50)}ms p90=${pct(si, 90)}ms max=${pct(si, 100)}ms; fillers played: ${all.filter((r) => r.bridgeMs != null).length}/${all.length}`);
    const byTool = {};
    for (const x of toolMs) (byTool[x.name] = byTool[x.name] || []).push(x.ms);
    for (const [name, list] of Object.entries(byTool)) console.log(`  tool ${name}: n=${list.length} p50=${pct(list, 50)}ms p90=${pct(list, 90)}ms max=${pct(list, 100)}ms`);
    console.log(`journal cost: $${costUsd.toFixed(4)} (~EUR ${(costUsd * 0.86).toFixed(3)}) for ${runs.filter((x) => x.sessionId).length} sessions`);
    console.log(`unverified names (journal): ${flagged.length}`);
    flagged.forEach((f) => console.log(`  - ${f}`));
    console.log('\nFAILED TURNS:');
    failed.forEach((r) => console.log(`  ${r.group}#${r.n} ${r.issues.join(' ')} | Q: ${r.q} | A: ${String(r.answer || '').slice(0, 160)}`));
    if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify({ at: new Date().toISOString(), runs, costUsd, flagged }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });

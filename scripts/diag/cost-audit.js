'use strict';

// Production cost audit (read-only). Pulls the priced usage records WITH the
// raw provider usage payloads from /api/cost/raw-records and prints:
//   - the dashboard summary as the API computes it;
//   - per local day: sessions, conversations, minutes, EUR by category;
//   - per category/operation: records, tokens, EUR;
//   - realtime: raw usage-event shape checks (duplicates, cumulative counters);
//   - the most expensive sessions with their per-event token timeline;
//   - per-session web search / answerability / embedding calls.
//
//   ADMIN_TOKEN=... AUDIT_FROM=2026-09-20 AUDIT_TO=2026-10-01 node scripts/diag/cost-audit.js

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN || '';
const FROM = process.env.AUDIT_FROM || '2026-09-20';
const TO = process.env.AUDIT_TO || new Date().toISOString().slice(0, 10);
const TOP = Number(process.env.AUDIT_TOP || 12);

async function get(path) {
    const res = await fetch(`${BASE_URL}${path}`, { headers: { 'x-admin-token': TOKEN } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

function localDay(iso, tz) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function eventTokens(u) {
    const d = (list, mod) => (Array.isArray(list) ? list.filter((x) => String(x.modality).toUpperCase() === mod).reduce((a, x) => a + (x.tokenCount || 0), 0) : 0);
    return {
        prompt: u.promptTokenCount || 0,
        response: u.responseTokenCount || u.candidatesTokenCount || 0,
        total: u.totalTokenCount || 0,
        inText: d(u.promptTokensDetails, 'TEXT'),
        inAudio: d(u.promptTokensDetails, 'AUDIO'),
        outText: d(u.responseTokensDetails || u.candidatesTokensDetails, 'TEXT'),
        outAudio: d(u.responseTokensDetails || u.candidatesTokensDetails, 'AUDIO'),
        cached: u.cachedContentTokenCount || 0,
        tool: u.toolUsePromptTokenCount || 0,
        thoughts: u.thoughtsTokenCount || 0,
        // Keys present, to see the payload shape without dumping values.
        keys: Object.keys(u).sort().join(','),
    };
}

async function main() {
    console.log(`cost audit ${BASE_URL} range ${FROM}..${TO}`);
    const summary = await get('/api/cost/summary');
    const p = summary.periods;
    console.log('\n== DASHBOARD (API) ==');
    console.log(`rates: 1 EUR=${summary.rates.eur_to_mdl} MDL, 1 USD=${summary.rates.usd_to_eur} EUR, tz=${summary.timezone}, generated=${summary.generated_at}`);
    for (const [k, v] of Object.entries({ today: p.today, last_7_days: p.last_7_days, month: p.month })) {
        console.log(`${k}: ${v.from} -> ${v.to} conv=${v.conversations} sessions=${v.realtime_sessions} api_calls=${v.api_calls} minutes=${r2(v.conversation_duration_ms / 60000)} eur=${r4(v.cost_eur)} actual_eur=${r4(v.actual_cost_eur)} est_eur=${r4(v.estimated_cost_eur)} unpriced=${v.unpriced_records} basis=${v.basis}`);
    }
    console.log(`month elapsed_fraction=${p.month.elapsed_fraction} projected_api_mdl=${r2(p.month.projected_api_cost_mdl)}`);

    const raw = await get(`/api/cost/raw-records?from=${FROM}&to=${TO}&limit=5000`);
    const tz = raw.settings.timezone || 'Europe/Chisinau';
    const recs = raw.records;
    console.log(`\nrecords: ${recs.length} (total ${raw.total}) from ${raw.from} to ${raw.to}`);

    console.log('\n== BY LOCAL DAY ==');
    console.log('day | rt_sessions | conversations | conv_min | rt_eur | llm_eur | web_eur | emb_eur | other_eur | total_eur | eur/conv_min');
    const days = [...new Set(recs.map((r) => localDay(r.occurred_at, tz)))].sort();
    for (const day of days) {
        const d = recs.filter((r) => localDay(r.occurred_at, tz) === day);
        const rt = d.filter((r) => r.kind === 'realtime_session');
        const conv = rt.filter((r) => r.turn_count > 0);
        const cat = (c) => sum(d.filter((r) => r.category === c), (r) => r.cost.eur);
        const total = sum(d, (r) => r.cost.eur);
        const mins = sum(conv, (r) => r.duration_ms) / 60000;
        const rtEur = cat('realtime_gemini') + cat('realtime_grok');
        console.log(`${day} | ${rt.length} | ${conv.length} | ${r2(mins)} | ${r4(rtEur)} | ${r4(cat('llm_text'))} | ${r4(cat('web_search'))} | ${r4(cat('embedding'))} | ${r4(cat('other') + cat('tts'))} | ${r4(total)} | ${mins > 0 ? r4(rtEur / mins) : '-'}`);
    }

    console.log('\n== BY CATEGORY / PROVIDER / MODEL / OPERATION ==');
    const groups = new Map();
    for (const r of recs) {
        const key = `${r.category} | ${r.provider} | ${r.model} | ${r.operation || r.kind}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const grand = sum(recs, (r) => r.cost.eur);
    console.log('key | records | in_text | in_audio | in_other | out_text | out_audio | out_other | cached | requests | in_chars | audio_in_s | audio_out_s | basis(actual/est) | eur | %');
    for (const [key, list] of [...groups.entries()].sort((a, b) => sum(b[1], (r) => r.cost.eur) - sum(a[1], (r) => r.cost.eur))) {
        const u = (k) => Math.round(sum(list, (r) => r.usage?.[k]));
        const eur = sum(list, (r) => r.cost.eur);
        const act = list.filter((r) => r.cost.basis === 'actual').length;
        console.log(`${key} | ${list.length} | ${u('input_text_tokens')} | ${u('input_audio_tokens')} | ${u('input_other_tokens')} | ${u('output_text_tokens')} | ${u('output_audio_tokens')} | ${u('output_other_tokens')} | ${u('cached_tokens')} | ${u('requests')} | ${u('input_chars')} | ${u('audio_input_seconds')} | ${u('audio_output_seconds')} | ${act}/${list.length - act} | ${r4(eur)} | ${grand ? r2((eur / grand) * 100) : 0}`);
    }
    console.log(`GRAND TOTAL eur=${r4(grand)}`);

    const rts = recs.filter((r) => r.kind === 'realtime_session');
    console.log('\n== REALTIME USAGE-EVENT SHAPE ==');
    let evTotal = 0; let dupConsecutive = 0; let nonMonotonicPrompt = 0; let monotonicSessions = 0; let multiEventSessions = 0;
    const keyShapes = new Map();
    for (const s of rts) {
        const evs = s.usage_raw?.provider_usage_events || [];
        evTotal += evs.length;
        if (evs.length > 1) multiEventSessions += 1;
        let mono = true;
        for (let i = 0; i < evs.length; i += 1) {
            const t = eventTokens(evs[i].usage || {});
            keyShapes.set(t.keys, (keyShapes.get(t.keys) || 0) + 1);
            if (i > 0) {
                const prev = eventTokens(evs[i - 1].usage || {});
                if (JSON.stringify(evs[i].usage) === JSON.stringify(evs[i - 1].usage)) dupConsecutive += 1;
                if (t.prompt < prev.prompt) { mono = false; nonMonotonicPrompt += 1; }
            }
        }
        if (evs.length > 1 && mono) monotonicSessions += 1;
    }
    console.log(`realtime sessions=${rts.length} with_turns=${rts.filter((r) => r.turn_count > 0).length} usage_events=${evTotal} sessions_with>1_event=${multiEventSessions} sessions_with_monotonic_prompt=${monotonicSessions} prompt_decreases=${nonMonotonicPrompt} identical_consecutive_events=${dupConsecutive}`);
    console.log(`dropped_events_total=${sum(rts, (r) => r.usage_raw?.dropped_events)}`);
    for (const [k, c] of keyShapes) console.log(`event keys [${k}] x${c}`);
    const noTurnCost = rts.filter((r) => r.turn_count === 0);
    console.log(`sessions without turns: ${noTurnCost.length}, their eur=${r4(sum(noTurnCost, (r) => r.cost.eur))}`);
    const byBasis = (b) => rts.filter((r) => r.usage_basis === b);
    console.log(`realtime usage_basis actual=${byBasis('actual').length} (eur ${r4(sum(byBasis('actual'), (r) => r.cost.eur))}) estimated=${byBasis('estimated').length} (eur ${r4(sum(byBasis('estimated'), (r) => r.cost.eur))})`);
    const methods = new Map();
    for (const r of recs) methods.set(`${r.category}:${r.cost.method}:${r.cost.basis}`, (methods.get(`${r.category}:${r.cost.method}:${r.cost.basis}`) || 0) + 1);
    for (const [k, c] of methods) console.log(`pricing method ${k} x${c}`);

    // Per-session api calls (web search etc.) by session_id.
    const apiBySession = new Map();
    for (const r of recs.filter((x) => x.kind === 'api_call' && x.session_id)) {
        if (!apiBySession.has(r.session_id)) apiBySession.set(r.session_id, []);
        apiBySession.get(r.session_id).push(r);
    }
    const apiNoSession = recs.filter((x) => x.kind === 'api_call' && !x.session_id);
    console.log(`\napi calls with session_id=${sum([...apiBySession.values()], (l) => l.length)} without=${apiNoSession.length} (eur ${r4(sum(apiNoSession, (r) => r.cost.eur))})`);
    const noSessByOp = new Map();
    for (const r of apiNoSession) {
        const k = `${r.operation}@${localDay(r.occurred_at, tz)}`;
        const v = noSessByOp.get(k) || { n: 0, eur: 0, chars: 0 };
        v.n += 1; v.eur += r.cost.eur || 0; v.chars += r.usage?.input_chars || 0;
        noSessByOp.set(k, v);
    }
    for (const [k, v] of [...noSessByOp.entries()].sort()) console.log(`  no-session ${k}: n=${v.n} chars=${v.chars} eur=${r4(v.eur)}`);

    console.log(`\n== TOP ${TOP} REALTIME SESSIONS BY COST ==`);
    const top = [...rts].sort((a, b) => (b.cost.eur || 0) - (a.cost.eur || 0)).slice(0, TOP);
    for (const s of top) {
        const evs = s.usage_raw?.provider_usage_events || [];
        const api = apiBySession.get(s.session_id) || [];
        const ops = {};
        for (const a of api) ops[a.operation] = (ops[a.operation] || 0) + 1;
        const m = s.usage_raw?.measured || {};
        console.log(`\nSESSION ${s.session_id} ${s.occurred_at} local=${localDay(s.occurred_at, tz)} dur_s=${r2(s.duration_ms / 1000)} model=${s.model} turns=${s.turn_count} conns=${s.provider_connections} end=${s.end_reason} voice_mode=${s.voice_mode} eur=${r4(s.cost.eur)} basis=${s.cost.basis}/${s.cost.method}`);
        console.log(`  usage: in_text=${s.usage.input_text_tokens} in_audio=${s.usage.input_audio_tokens} in_other=${s.usage.input_other_tokens} out_text=${s.usage.output_text_tokens} out_audio=${s.usage.output_audio_tokens} out_other=${s.usage.output_other_tokens} cached=${s.usage.cached_tokens} measured_in_s=${s.usage.audio_input_seconds} measured_out_s=${s.usage.audio_output_seconds} out_bytes=${m.output_audio_bytes}`);
        console.log(`  api calls: ${JSON.stringify(ops)} api_eur=${r4(sum(api, (a) => a.cost.eur))}`);
        console.log(`  events (${evs.length}${s.usage_raw?.dropped_events ? `, dropped ${s.usage_raw.dropped_events}` : ''}): at | inst | prompt | inText | inAudio | cached | tool | response | outText | outAudio | thoughts | total`);
        for (const e of evs.slice(0, 80)) {
            const t = eventTokens(e.usage || {});
            console.log(`  ${String(e.at).slice(11, 23)} | ${String(e.provider_instance_id || '').slice(-6)} | ${t.prompt} | ${t.inText} | ${t.inAudio} | ${t.cached} | ${t.tool} | ${t.response} | ${t.outText} | ${t.outAudio} | ${t.thoughts} | ${t.total}`);
        }
        if (evs.length > 80) console.log(`  ... ${evs.length - 80} more events`);
    }

    console.log('\n== ALL CONVERSATION SESSIONS (compact) ==');
    console.log('started | local_day | dur_s | turns | conns | events | prompt_sum | prompt_max | in_audio | out_audio | out_text | measured_in_s | measured_out_s | web | answerability | eur');
    for (const s of rts.filter((r) => r.turn_count > 0).sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))) {
        const evs = (s.usage_raw?.provider_usage_events || []).map((e) => eventTokens(e.usage || {}));
        const api = apiBySession.get(s.session_id) || [];
        const web = api.filter((a) => a.category === 'web_search').length;
        const ans = api.filter((a) => a.operation === 'answerability_check').length;
        console.log(`${s.occurred_at.slice(0, 19)} | ${localDay(s.occurred_at, tz)} | ${r2(s.duration_ms / 1000)} | ${s.turn_count} | ${s.provider_connections} | ${evs.length} | ${sum(evs, (e) => e.prompt)} | ${Math.max(0, ...evs.map((e) => e.prompt))} | ${s.usage.input_audio_tokens} | ${s.usage.output_audio_tokens} | ${s.usage.output_text_tokens} | ${s.usage.audio_input_seconds} | ${s.usage.audio_output_seconds} | ${web} | ${ans} | ${r4(s.cost.eur)}`);
    }
}

main().catch((error) => { console.error(error); process.exit(1); });

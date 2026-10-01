'use strict';

// Production cost benchmark: one scripted /lite conversation (typed turns,
// same script every run), then the provider-reported usage of exactly that
// session from /api/cost/raw-records, priced per turn. Run it before and
// after a cost change to compare like for like.
//
//   ADMIN_TOKEN=... node scripts/diag/cost-bench.js

const WS = require('ws');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const TOKEN = process.env.ADMIN_TOKEN || '';

// A realistic short visitor conversation: knowledge questions (tool calls)
// mixed with short follow-ups.
const TURNS = [
    'Привет! Посоветуй сухое красное вино к стейку.',
    'А что-нибудь подешевле, до 300 лей?',
    'Расскажи про винодельню Purcari.',
    'Интересно. А как туда доехать из Кишинёва?',
    'Что такое Фетяска Нягрэ?',
    'С какой едой её лучше пить?',
    'А белое вино к рыбе посоветуешь?',
    'Хорошо, спасибо.',
    'Где можно попробовать игристое вино в Молдове?',
    'А дегустации в Кишинёве есть?',
    'Какая температура подачи для красного?',
    'Спасибо, ты очень помогла!',
];

// List prices used by the Cost Control pricing table (USD per 1M tokens).
const PRICE = { textIn: 0.75, audioIn: 3, textOut: 4.5, audioOut: 12 };
const USD_TO_EUR = 0.86;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(pathname, options = {}) {
    const headers = { ...(options.headers || {}), ...(TOKEN ? { 'x-admin-token': TOKEN } : {}) };
    const res = await fetch(`${BASE_URL}${pathname}`, { ...options, headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
}

function open(url) {
    return new Promise((resolve, reject) => {
        const ws = new WS(url, TOKEN ? { headers: { 'x-admin-token': TOKEN } } : undefined);
        const events = [];
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            try { events.push({ at: Date.now(), ...JSON.parse(data.toString()) }); } catch { /* ignore */ }
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

function detail(list, modality) {
    return (Array.isArray(list) ? list : []).filter((x) => String(x.modality).toUpperCase() === modality).reduce((a, x) => a + (x.tokenCount || 0), 0);
}

function eventCost(u) {
    const prompt = u.promptTokenCount || 0;
    const inText = detail(u.promptTokensDetails, 'TEXT');
    const inAudio = detail(u.promptTokensDetails, 'AUDIO');
    const inOther = Math.max(0, prompt - inText - inAudio);
    const outAudio = detail(u.responseTokensDetails, 'AUDIO');
    const outText = Math.max(0, (u.responseTokenCount || 0) - outAudio);
    // Unitemized prompt tokens priced as text here (the dashboard prices
    // them at the audio rate); both columns are printed.
    const usd = (inText * PRICE.textIn + inAudio * PRICE.audioIn + inOther * PRICE.textIn + outText * PRICE.textOut + outAudio * PRICE.audioOut) / 1e6;
    const usdDashboard = usd + (inOther * (PRICE.audioIn - PRICE.textIn)) / 1e6;
    return { prompt, inText, inAudio, inOther, outAudio, eur: usd * USD_TO_EUR, eurDashboard: usdDashboard * USD_TO_EUR };
}

async function main() {
    const age = await http('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    const av = age.json?.token ? `&av=${encodeURIComponent(age.json.token)}` : '';
    const conn = await open(`${WS_BASE}/realtime?channel=lite${av}`);
    const ready = await waitFor(conn.events, (e) => e.type === 'session.ready', 10000);
    const sessionId = ready?.session_id;
    conn.send({ type: 'session.start', sampleRate: 16000, language: 'ru' });
    await waitFor(conn.events, (e) => e.type === 'provider.ready', 20000);
    console.log(`session ${sessionId} model=${ready?.model}`);
    const startedAt = Date.now();
    for (const [i, text] of TURNS.entries()) {
        const from = conn.events.length;
        const t0 = Date.now();
        conn.send({ type: 'input_text.submit', text });
        const end = await waitFor(conn.events, (e) => ['audio.end', 'response.done', 'response.failed'].includes(e.type), 45000, from);
        const tools = conn.events.slice(from).filter((e) => e.type === 'tool.call').map((e) => e.tool_name);
        const answer = conn.events.slice(from).filter((e) => e.type === 'transcript.model').map((e) => e.text).join('').replace(/\s+/g, ' ').trim();
        console.log(`turn ${i + 1} ${end ? end.type : 'TIMEOUT'} ${Date.now() - t0}ms tools=[${tools.join(',')}] Q: ${text}`);
        console.log(`   A: ${answer.slice(0, 260)}`);
        await sleep(800);
    }
    console.log(`conversation wall time ${Math.round((Date.now() - startedAt) / 1000)}s`);
    conn.ws.close();

    // The session record is written on disconnect.
    let record = null;
    const day = new Date().toISOString().slice(0, 10);
    for (let attempt = 0; attempt < 20 && !record; attempt += 1) {
        await sleep(3000);
        const raw = await http(`/api/cost/raw-records?from=${day}&to=${day}&limit=500`);
        record = (raw.json?.records || []).find((r) => r.session_id === sessionId && r.kind === 'realtime_session') || null;
    }
    if (!record) { console.log('session record not found'); process.exit(1); }
    const events = record.usage_raw?.provider_usage_events || [];
    console.log('\nturn | prompt | inText | inAudio | inOther | outAudio | eur | eur(dashboard pricing)');
    let total = 0; let totalDash = 0;
    events.forEach((e, i) => {
        const c = eventCost(e.usage || {});
        total += c.eur; totalDash += c.eurDashboard;
        console.log(`${i + 1} | ${c.prompt} | ${c.inText} | ${c.inAudio} | ${c.inOther} | ${c.outAudio} | ${c.eur.toFixed(4)} | ${c.eurDashboard.toFixed(4)}`);
    });
    const prompts = events.map((e) => e.usage?.promptTokenCount || 0);
    console.log(`\nBENCH turns=${TURNS.length} usage_events=${events.length} prompt_sum=${prompts.reduce((a, b) => a + b, 0)} prompt_max=${Math.max(0, ...prompts)} eur=${total.toFixed(4)} eur_dashboard=${totalDash.toFixed(4)} dashboard_record_eur=${Number(record.cost?.eur || 0).toFixed(4)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

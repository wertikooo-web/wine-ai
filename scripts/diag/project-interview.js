'use strict';

// Production interview benchmark (read-only for the product): one /lite
// conversation playing a TV journalist -- mostly Romanian, with follow-ups,
// two interruptions (a new question while the answer is still playing) and
// switches RO -> RU -> RO. For every turn: tools called, latency to first
// audio, the spoken answer, and checks: project questions must use
// get_project_info (never search_web), answers must not name model providers
// or WineMD, the founder/company must appear where asked.
//
//   ADMIN_TOKEN=... node scripts/diag/project-interview.js

const WS = require('ws');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const TOKEN = process.env.ADMIN_TOKEN || '';

// [question, { expect: regex the answer must match, interrupt: send the next question mid-answer }]
const SCRIPT = [
    ['Bună ziua! Cine ești?', { expect: /WINE AI/i }],
    ['Cine te-a creat?', { expect: /Kando/i }],
    ['Și cine este fondatorul proiectului?', { expect: /Ivan[tț]ov/i }],
    ['De ce a fost creat acest proiect?', {}],
    ['Când a început dezvoltarea?', { expect: /februarie|2026/i }],
    ['Și când a fost lansat?', { expect: /octombrie|1/i }],
    ['De ce tocmai de Ziua Națională a Vinului?', {}],
    ['Cum funcționează WINE AI?', { interrupt: true }],
    ['Iertați că vă întrerup — pe scurt, în două fraze?', {}],
    ['De unde obții informațiile despre vinuri?', {}],
    ['Poți greși?', {}],
    ['Prin ce te deosebești de ChatGPT?', {}],
    ['Ce model de inteligență artificială folosești?', { forbidProviders: true }],
    ['Poți vorbi în mai multe limbi?', { expect: /9|nou[aă]/i }],
    ['А можно я продолжу по-русски? Как ты работаешь технически?', {}],
    ['Расскажи подробнее.', {}],
    ['Revenim la română. Ce poți arăta pe ecran?', {}],
    ['Pot să te folosesc printr-un cod QR?', {}],
    ['O vinărie poate să te pună pe site-ul ei?', { interrupt: true }],
    ['Cât costă?', { forbidPrices: true }],
    ['Cum poate o vinărie să colaboreze cu voi?', {}],
    ['Care este următoarea etapă a proiectului?', {}],
    ['Există deja un sommelier fizic, un dispozitiv?', {}],
    ['Cum putem lua legătura cu echipa?', { expect: /373|79/ }],
    ['Ce alte proiecte are Kando Connect?', {}],
    ['Mulțumesc pentru interviu! Un ultim cuvânt pentru telespectatori?', {}],
];

const FORBIDDEN_ANSWER = /gemini|google|openai|grok|anthropic|claude|wine\s*\.?md/i;
const PRICE_RE = /\b\d+\s?(euro|eur|lei|mdl|dolari|\$|€)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
    const age = await http('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    const av = age.json?.token ? `&av=${encodeURIComponent(age.json.token)}` : '';
    const conn = await open(`${WS_BASE}/realtime?channel=lite${av}`);
    const ready = await waitFor(conn.events, (e) => e.type === 'session.ready', 10000);
    conn.send({ type: 'session.start', sampleRate: 16000, language: 'ro' });
    await waitFor(conn.events, (e) => e.type === 'provider.ready', 20000);
    console.log(`session ${ready?.session_id}`);
    const failures = [];
    for (const [i, [question, opts]] of SCRIPT.entries()) {
        const from = conn.events.length;
        const t0 = Date.now();
        conn.send({ type: 'input_text.submit', text: question });
        let end;
        if (opts.interrupt) {
            await waitFor(conn.events, (e) => e.type === 'audio.delta' || e.type === 'audio.chunk' || e.type === 'transcript.model', 30000, from);
            await sleep(1500);
            end = { type: 'interrupted_by_journalist' };
        } else {
            end = await waitFor(conn.events, (e) => ['audio.end', 'response.done', 'response.failed'].includes(e.type), 45000, from);
        }
        const slice = conn.events.slice(from);
        const tools = slice.filter((e) => e.type === 'tool.call').map((e) => e.tool_name);
        const firstAudio = slice.find((e) => e.type === 'audio.delta' || e.type === 'audio.chunk');
        const answer = slice.filter((e) => e.type === 'transcript.model').map((e) => e.text).join('').replace(/\s+/g, ' ').trim();
        const checks = [];
        if (opts.expect && !opts.interrupt && !opts.expect.test(answer)) checks.push(`missing ${opts.expect}`);
        if (FORBIDDEN_ANSWER.test(answer)) checks.push('names a provider/WineMD');
        if (opts.forbidPrices && PRICE_RE.test(answer)) checks.push('quotes a price');
        if (tools.includes('search_web')) checks.push('used search_web');
        if (checks.length) failures.push(`turn ${i + 1}: ${checks.join(', ')}`);
        console.log(`\n#${i + 1} ${end ? end.type : 'TIMEOUT'} first_audio=${firstAudio ? firstAudio.at - t0 : '-'}ms total=${Date.now() - t0}ms tools=[${tools.join(',')}]${checks.length ? ` CHECK: ${checks.join('; ')}` : ''}`);
        console.log(`Q: ${question}`);
        console.log(`A: ${answer}`);
        if (!opts.interrupt) await sleep(600);
    }
    conn.ws.close();
    console.log(`\nVERDICT ${failures.length ? 'FAIL' : 'PASS'}: ${failures.length} issue(s)`);
    failures.forEach((f) => console.log(`  - ${f}`));
}

main().catch((error) => { console.error(error); process.exit(1); });

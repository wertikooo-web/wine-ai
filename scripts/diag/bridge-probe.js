'use strict';

// Production diagnostic (read-only for the product: opens ordinary
// conversations, changes no configuration). Prints a millisecond timeline
// per turn: submit -> tool.call -> assistant.bridge -> tool.response ->
// response.created / first audio -> audio.end.
//
//   BASE_URL=https://... node scripts/diag/bridge-probe.js
//
// Writes /tmp/bridge-probe/question.wav (the spoken question, used by the
// browser probe as the fake microphone).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WS = require('ws');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const OUT_DIR = process.env.PROBE_OUT || '/tmp/bridge-probe';
const QUESTIONS = [
    // Needs fresh facts -> web grounding (the long operation).
    'Какие новости у винодельни Purcari за последнюю неделю? Назови конкретные даты.',
    'Какие винные фестивали пройдут в Молдове в октябре этого года? Назови даты.',
    'Сколько сейчас стоит бутылка Negru de Purcari в магазинах Кишинёва?',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(pathname, options = {}) {
    const res = await fetch(`${BASE_URL}${pathname}`, { redirect: 'manual', ...options });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json, headers: res.headers };
}

function open(url) {
    return new Promise((resolve, reject) => {
        const ws = new WS(url);
        const events = [];
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            try { events.push({ at: Date.now(), ...JSON.parse(data.toString()) }); } catch { /* ignore */ }
        });
        ws.on('open', () => resolve({ ws, events, send: (p) => ws.send(JSON.stringify(p)) }));
        ws.on('error', reject);
        ws.on('unexpected-response', (req, res) => reject(new Error(`upgrade http ${res.statusCode}`)));
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

function summarize(e) {
    const out = { type: e.type };
    if (e.generation_id) out.gen = String(e.generation_id).slice(-6);
    if (e.tool_name) out.tool = e.tool_name;
    if (e.tool_names) out.tools = e.tool_names.join(',');
    if (e.type === 'assistant.bridge') {
        out.text = e.text;
        out.audio_ms = Math.round((Buffer.from(e.audio_base64 || '', 'base64').length / 2) / (e.sample_rate || 24000) * 1000);
    }
    if (e.type === 'transcript.model' || e.type === 'transcript.user') out.text = String(e.text || '').slice(0, 60);
    if (e.type === 'error' || e.type === 'response.failed') { out.code = e.code || e.reason; out.message = String(e.message || '').slice(0, 100); }
    return out;
}

// One turn: returns the timeline relative to submit.
async function turn(conn, { text, pcm16k, label }) {
    const start = conn.events.length;
    const t0 = Date.now();
    if (text) {
        conn.send({ type: 'input_text.submit', text });
    } else {
        conn.send({ type: 'input_audio.start', mode: 'push_to_talk' });
        const frame = 640; // 20 ms @ 16 kHz
        for (let i = 0; i < pcm16k.length; i += frame) {
            conn.ws.send(pcm16k.subarray(i, i + frame));
            await sleep(20);
        }
        conn.send({ type: 'input_audio.end' });
    }
    const tEnd = Date.now();
    await waitFor(conn.events, (e) => ['audio.end', 'response.done', 'response.failed'].includes(e.type), 45000, start);
    await sleep(800);
    const rows = conn.events.slice(start)
        .filter((e) => !['audio.chunk', 'visual.avatar.state', 'transcript.model'].includes(e.type))
        .map((e) => ({ ms: e.at - tEnd, ...summarize(e) }));
    const firstOf = (type) => conn.events.slice(start).find((e) => e.type === type);
    const rel = (e) => (e ? e.at - tEnd : null);
    const answer = conn.events.slice(start).filter((e) => e.type === 'transcript.model').map((e) => e.text).join('').replace(/\s+/g, ' ').trim();
    const result = {
        label,
        input: text ? 'text' : `voice ${Math.round(pcm16k.length / 32)}ms`,
        submit_to_input_end_ms: tEnd - t0,
        tool_call_ms: rel(firstOf('tool.call')),
        bridge_ms: rel(firstOf('assistant.bridge')),
        tool_response_ms: rel(firstOf('tool.response')),
        response_created_ms: rel(firstOf('response.created')),
        first_audio_ms: rel(firstOf('audio.chunk')),
        audio_end_ms: rel(firstOf('audio.end')),
        bridge: firstOf('assistant.bridge') ? summarize(firstOf('assistant.bridge')) : null,
        answer_chars: answer.length,
        answer_head: answer.slice(0, 90),
        events_between_tool_call_and_answer: (() => {
            const tc = firstOf('tool.call');
            if (!tc) return [];
            const until = firstOf('response.created')?.at || Infinity;
            return conn.events.slice(start).filter((e) => e.at >= tc.at && e.at <= until && !['tool.call', 'tool.response', 'assistant.bridge'].includes(e.type)).map((e) => `${e.at - tEnd}ms ${e.type}`);
        })(),
        timeline: rows,
    };
    return result;
}

function pcm24kTo16k(buf) {
    const src = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    const n = Math.floor(src.length * 16000 / 24000);
    const out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) {
        const x = i * 1.5;
        const a = src[Math.floor(x)] || 0;
        const b = src[Math.min(src.length - 1, Math.floor(x) + 1)] || 0;
        out.writeInt16LE(Math.round(a + (b - a) * (x - Math.floor(x))), i * 2);
    }
    return out;
}

function wav(pcm, sampleRate) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

async function session(label, url, turns) {
    const out = { label, url: url.replace(/av=[^&]+/, 'av=…') };
    let conn;
    try { conn = await open(url); } catch (error) { out.error = error.message; return out; }
    const ready = await waitFor(conn.events, (e) => e.type === 'session.ready', 10000);
    conn.send({ type: 'session.start', sampleRate: 16000 });
    await waitFor(conn.events, (e) => e.type === 'session.config.applied', 15000);
    out.config = ready ? { session_id: ready.session_id, provider: ready.provider, model: ready.model, rotation_mode: ready.rotation_mode } : null;
    await waitFor(conn.events, (e) => e.type === 'provider.ready', 15000);
    // Give the process-wide bridge phrase cache time to render (prewarm).
    await sleep(Number(process.env.PROBE_WARM_MS || 12000));
    out.turns = [];
    for (const t of turns) {
        out.turns.push(await turn(conn, t));
        await sleep(1500);
    }
    conn.ws.close();
    return out;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const report = { base_url: BASE_URL, at: new Date().toISOString() };

    // Wait for a build that reports bridge status (/health.bridge, #89+).
    for (let attempt = 1; attempt <= Number(process.env.PROBE_DEPLOY_WAIT_TRIES || 1); attempt += 1) {
        const health = await http('/health');
        report.health_bridge = health.json?.bridge || null;
        if (report.health_bridge) break;
        console.log(`waiting for a deployment with /health.bridge (attempt ${attempt})`);
        await sleep(15000);
    }
    console.log(`/health.bridge before sessions: ${JSON.stringify(report.health_bridge)}`);

    // Deployment fingerprint: the served /lite page vs candidate commits.
    const lite = await http('/lite');
    report.lite_sha256 = crypto.createHash('sha256').update(lite.text).digest('hex');
    report.lite_has_bridge_client = lite.text.includes("case 'assistant.bridge'");
    const candidates = String(process.env.CANDIDATE_HASHES || '').split(/\s+/).filter(Boolean).map((row) => row.split('=')); // sha=hash
    report.deployed_commit = (candidates.find(([, h]) => h === report.lite_sha256) || [null])[0];

    const liveState = await http('/api/live-test/state');
    report.published = liveState.json ? { revision: liveState.json.published?.revision, config: liveState.json.published?.config, http: liveState.status } : { http: liveState.status };
    const liteConfig = await http('/api/lite/config');
    report.lite_config = liteConfig.json ? { persona: liteConfig.json.persona?.id, visual_companion: liteConfig.json.visual_companion } : { http: liteConfig.status };
    const ttsBefore = await http('/api/cost/breakdown');
    const ttsRow = (b) => (b.json?.by_provider_model || []).filter((r) => /tts/i.test(r.model || ''));
    report.tts_records_before = ttsRow(ttsBefore).map((r) => ({ model: r.model, records: r.records }));

    // Spoken question for the voice turns (Gemini TTS, same engine that
    // renders the bridge phrases: its failure would also explain no bridge).
    const tts = await http('/api/voice-preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'gemini', voice_name: 'Puck', text: QUESTIONS[0] }) });
    report.tts_voice_preview = { http: tts.status, error: tts.json?.error || null };
    let pcm16k = null;
    if (tts.json?.audio_base64) {
        const pcm24 = Buffer.from(tts.json.audio_base64, 'base64');
        pcm16k = pcm24kTo16k(pcm24);
        const silence = (s) => Buffer.alloc(24000 * 2 * s);
        fs.writeFileSync(path.join(OUT_DIR, 'question.wav'), wav(Buffer.concat([silence(1), pcm24, silence(45)]), 24000));
    }

    const age = await http('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
    const av = age.json?.token ? `&av=${encodeURIComponent(age.json.token)}` : '';

    const liteTurns = [
        { label: 'lite text Q1', text: QUESTIONS[0] },
        { label: 'lite text Q2', text: QUESTIONS[1] },
        { label: 'lite text Q3', text: QUESTIONS[2] },
    ];
    if (pcm16k) liteTurns.push({ label: 'lite voice Q1 (PTT)', pcm16k });
    report.sessions = [];
    report.sessions.push(await session('lite (published config)', `${WS_BASE}/realtime?channel=lite${av}`, liteTurns));
    report.sessions.push(await session('dashboard gemini', `${WS_BASE}/realtime?provider=gemini`, [{ label: 'gemini text Q1', text: QUESTIONS[1] }, { label: 'gemini text Q2', text: QUESTIONS[2] }]));
    report.sessions.push(await session('dashboard grok', `${WS_BASE}/realtime?provider=grok`, [{ label: 'grok text Q1', text: QUESTIONS[1] }, { label: 'grok text Q2', text: QUESTIONS[2] }]));

    const healthAfter = await http('/health');
    console.log(`/health.bridge after sessions: ${JSON.stringify(healthAfter.json?.bridge || null)}`);
    const ttsAfter = await http('/api/cost/breakdown');
    report.tts_records_after = ttsRow(ttsAfter).map((r) => ({ model: r.model, records: r.records }));

    fs.writeFileSync(path.join(OUT_DIR, 'ws-report.json'), JSON.stringify(report, null, 2));
    // Human-readable
    console.log(`deployed /lite sha256=${report.lite_sha256} -> commit ${report.deployed_commit || 'UNKNOWN'}; bridge client code present=${report.lite_has_bridge_client}`);
    console.log(`published config: ${JSON.stringify(report.published)}`);
    console.log(`voice-preview TTS: ${JSON.stringify(report.tts_voice_preview)}; tts records before=${JSON.stringify(report.tts_records_before)} after=${JSON.stringify(report.tts_records_after)}`);
    for (const s of report.sessions) {
        console.log(`\n=== ${s.label} ${s.error ? 'ERROR ' + s.error : JSON.stringify(s.config)}`);
        for (const t of s.turns || []) {
            console.log(`--- ${t.label} [${t.input}] tool.call=${t.tool_call_ms} bridge=${t.bridge_ms} tool.response=${t.tool_response_ms} response.created=${t.response_created_ms} first_audio=${t.first_audio_ms} audio.end=${t.audio_end_ms} answer_chars=${t.answer_chars}`);
            if (t.bridge) console.log(`    bridge: ${JSON.stringify(t.bridge)}`);
            console.log(`    events between tool.call and answer: ${JSON.stringify(t.events_between_tool_call_and_answer)}`);
            for (const r of t.timeline) console.log(`    ${String(r.ms).padStart(6)}ms ${JSON.stringify(r)}`);
        }
    }
}

main().catch((error) => { console.error(error); process.exit(1); });

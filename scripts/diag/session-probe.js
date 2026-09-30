'use strict';

// Production diagnostic: one real /lite Free Conversation in Chrome with a
// scripted fake microphone (Russian questions at fixed times, the last one
// started just before the 3:00 limit). Samples the countdown every second
// and records, per turn: user text, answer text/length, language events,
// plus session-limit telemetry and when the WebSocket closes.
//
//   BASE_URL=https://... CHROME=/usr/bin/google-chrome node scripts/diag/session-probe.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const OUT_DIR = process.env.PROBE_OUT || '/tmp/session-probe';
const TOTAL_MS = Number(process.env.PROBE_TOTAL_MS || 250000);
// Same Russian question at each mark (controlled, no Ukrainian words).
const QUESTION = 'Расскажите, пожалуйста, какие красные вина Молдовы стоит попробовать и почему?';
const MARKS_S = String(process.env.PROBE_MARKS || '3,60,120,176').split(',').map(Number);

async function tts(text) {
    const res = await fetch(`${BASE_URL}/api/voice-preview`, { method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {}) }, body: JSON.stringify({ provider: 'gemini', voice_name: 'Puck', text }) });
    const body = await res.json();
    if (!body.audio_base64) throw new Error(`tts failed http ${res.status} ${body.error || ''}`);
    return Buffer.from(body.audio_base64, 'base64'); // 24 kHz PCM16 mono
}

function wav(pcm, sampleRate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
    h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

const INSTRUMENT = () => {
    const log = [];
    window.__probe = log;
    const now = () => Math.round(performance.now());
    const NativeWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
        const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
        log.push({ t: now(), dir: 'ws_open' });
        ws.addEventListener('close', (e) => log.push({ t: now(), dir: 'ws_close', code: e.code }));
        ws.addEventListener('message', (m) => {
            if (typeof m.data !== 'string') return;
            try {
                const j = JSON.parse(m.data);
                if (['audio.chunk', 'visual.avatar.state'].includes(j.type)) return;
                const row = { t: now(), dir: 'in', type: j.type, gen: j.generation_id ? String(j.generation_id).slice(-6) : undefined, turn: j.turn_id };
                if (j.type === 'transcript.user' || j.type === 'transcript.model') row.text = String(j.text || '');
                if (/language/.test(j.type)) row.data = JSON.stringify(j).slice(0, 200);
                if (j.type === 'error' || j.type === 'response.failed') row.code = j.code || j.reason;
                if (j.type === 'session.config.applied') row.data = JSON.stringify({ reason: j.reason, prompt_source: j.prompt_source, meta: j.prompt_debug && j.prompt_debug.meta && { chars: j.prompt_debug.meta.promptChars, hash: j.prompt_debug.meta.promptHash } });
                if (j.type === 'session.ready') row.data = JSON.stringify({ provider: j.provider, model: j.model, rotation_mode: j.rotation_mode, session_id: j.session_id });
                if (j.type === 'provider.rotated' || j.type === 'provider.ready') row.data = JSON.stringify(j).slice(0, 240);
                log.push(row);
            } catch { /* ignore */ }
        });
        const send = ws.send.bind(ws);
        ws.send = (data) => {
            if (typeof data === 'string') {
                try {
                    const j = JSON.parse(data);
                    if (j.type === 'client_telemetry' && !/session_limit|auto_end|inactivity|closing|disconnect/.test(String(j.stage))) return send(data);
                    log.push({ t: now(), dir: 'out', type: j.type, stage: j.stage, text: j.text ? String(j.text).slice(0, 120) : undefined });
                } catch { /* ignore */ }
            }
            return send(data);
        };
        return ws;
    };
    window.WebSocket.prototype = NativeWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
};

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const q = await tts(QUESTION);
    const sr = 24000;
    const total = Buffer.alloc(sr * 2 * Math.ceil(TOTAL_MS / 1000 + 10));
    for (const s of MARKS_S) q.copy(total, Math.floor(s * sr) * 2);
    const wavPath = path.join(OUT_DIR, 'script.wav');
    fs.writeFileSync(wavPath, wav(total, sr));
    console.log(`question audio ${Math.round(q.length / 2 / sr * 1000)}ms at marks ${MARKS_S.join(', ')}s`);

    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME || '/usr/bin/google-chrome',
        headless: true,
        args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}%noloop`, '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(INSTRUMENT);
    await page.goto(`${BASE_URL}/lite`, { waitUntil: 'load', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const tTap = await page.evaluate(() => Math.round(performance.now()));
    await page.click('#pttBtn');
    await new Promise((r) => setTimeout(r, 400));
    if (await page.evaluate(() => { const b = document.getElementById('ageGateConfirm'); return Boolean(b && b.offsetParent); })) await page.click('#ageGateConfirm');

    const samples = [];
    const started = Date.now();
    while (Date.now() - started < TOTAL_MS) {
        const s = await page.evaluate(() => {
            const el = document.getElementById('voiceSessionTimer');
            const btn = document.getElementById('pttBtn');
            return {
                t: Math.round(performance.now()),
                text: el && !el.hidden ? el.textContent : null,
                ending: el ? el.classList.contains('ending') : null,
                color: el ? getComputedStyle(el).color : null,
                button: btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim().slice(0, 40) : null,
                body: document.body.className,
            };
        });
        samples.push(s);
        await new Promise((r) => setTimeout(r, 1000));
    }
    const log = await page.evaluate(() => window.__probe);
    await browser.close();

    fs.writeFileSync(path.join(OUT_DIR, 'session-log.json'), JSON.stringify({ log, samples }, null, 2));
    const rel = (t) => `${((t - tTap) / 1000).toFixed(1)}s`;

    console.log('\n== countdown (changes only)');
    let last = '';
    for (const s of samples) {
        const key = `${s.text}|${s.ending}|${s.color}|${s.button}`;
        if (s.text && (/^(3:00|2:3\d|2:0\d|1:0\d|0:3\d|0:2\d|0:1\d|0:0\d)$/.test(s.text) || key.split('|').slice(1).join('|') !== last.split('|').slice(1).join('|'))) {
            console.log(`  ${rel(s.t)} timer=${s.text} ending=${s.ending} color=${s.color} button="${s.button}"`);
        }
        if (!s.text && last && last.split('|')[0] !== 'null') console.log(`  ${rel(s.t)} timer hidden; button="${s.button}" body="${s.body}"`);
        last = key;
    }

    console.log('\n== session events');
    for (const r of log) {
        if (['ws_open', 'ws_close'].includes(r.dir) || r.dir === 'out' || ['session.ready', 'session.config.applied', 'provider.rotated', 'response.failed', 'error'].includes(r.type) || /language/.test(r.type || '')) {
            console.log(`  ${rel(r.t)} ${r.dir} ${r.type || ''} ${r.stage || ''} ${r.code !== undefined ? 'code=' + r.code : ''} ${r.data || ''} ${r.text || ''}`);
        }
    }

    console.log('\n== turns (user -> answer)');
    const byTurn = new Map();
    for (const r of log.filter((x) => x.type === 'transcript.user' || x.type === 'transcript.model')) {
        const k = r.gen || r.turn;
        if (!byTurn.has(k)) byTurn.set(k, { t: r.t, user: '', model: '' });
        const row = byTurn.get(k);
        if (r.type === 'transcript.user') row.user += r.text; else row.model += r.text;
    }
    let n = 0;
    for (const [, row] of byTurn) {
        n += 1;
        const model = row.model.replace(/\s+/g, ' ').trim();
        const sentences = model.split(/[.!?]+\s/).filter(Boolean).length;
        const cyr = (model.match(/[А-Яа-яЁё]/g) || []).length;
        const ukr = (model.match(/[ІіЇїЄєҐґ]/g) || []).length;
        console.log(`  #${n} ${rel(row.t)} user="${row.user.trim().slice(0, 70)}" answer_chars=${model.length} sentences~${sentences} cyrillic=${cyr} ukrainian_letters=${ukr}`);
        console.log(`      answer="${model.slice(0, 400)}"`);
    }
}

main().catch((error) => { console.error(error); process.exit(1); });

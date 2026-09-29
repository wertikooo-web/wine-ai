'use strict';

// Production diagnostic: the real /lite page in Chrome with a fake
// microphone that speaks a question (question.wav from bridge-probe.js).
// Instruments, inside the page:
//   - every WebSocket frame received / sent (type, generation, bridge text)
//   - every AudioBufferSourceNode.start(): buffer duration, sample rate,
//     RMS of the buffer (non-silent audio), AudioContext state
// and prints a millisecond timeline. "bridge played" = an
// assistant.bridge frame followed by a started, non-silent 24 kHz buffer
// of the same duration on a running AudioContext.
//
//   BASE_URL=https://... CHROME=/usr/bin/google-chrome node scripts/diag/bridge-browser-probe.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const OUT_DIR = process.env.PROBE_OUT || '/tmp/bridge-probe';
const LISTEN_MS = Number(process.env.PROBE_LISTEN_MS || 60000);

const INSTRUMENT = () => {
    const log = [];
    window.__probe = log;
    const now = () => Math.round(performance.now());
    const NativeWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
        const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
        log.push({ t: now(), dir: 'ws_open', url: String(url).replace(/av=[^&]+/, 'av=…') });
        ws.addEventListener('message', (m) => {
            if (typeof m.data !== 'string') return;
            try {
                const j = JSON.parse(m.data);
                const row = { t: now(), dir: 'in', type: j.type, gen: j.generation_id ? String(j.generation_id).slice(-6) : undefined };
                if (j.type === 'assistant.bridge') { row.text = j.text; row.samples = Math.floor(atob(j.audio_base64 || '').length / 2); row.sample_rate = j.sample_rate; }
                if (j.type === 'tool.call') row.tool = j.tool_name;
                if (j.type === 'transcript.user' || j.type === 'transcript.model') row.text = String(j.text || '').slice(0, 50);
                if (j.type === 'error' || j.type === 'response.failed') row.code = j.code || j.reason;
                if (j.type !== 'audio.chunk' || !log.some((r) => r.type === 'audio.chunk' && r.gen === row.gen)) log.push(row);
            } catch { /* ignore */ }
        });
        const send = ws.send.bind(ws);
        ws.send = (data) => {
            if (typeof data === 'string') {
                try {
                    const j = JSON.parse(data);
                    const row = { t: now(), dir: 'out', type: j.type };
                    if (j.type === 'client_telemetry') row.stage = j.stage || j.event || (j.payload && j.payload.stage);
                    if (j.type === 'client_telemetry' && !/bridge|session_limit|playback|barge|speech/.test(String(row.stage))) return send(data);
                    log.push(row);
                } catch { /* ignore */ }
            }
            return send(data);
        };
        return ws;
    };
    window.WebSocket.prototype = NativeWS.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
        try {
            const b = this.buffer;
            let rms = 0;
            if (b) {
                const d = b.getChannelData(0);
                const n = Math.min(d.length, 48000);
                let s = 0;
                for (let i = 0; i < n; i += 1) s += d[i] * d[i];
                rms = Math.sqrt(s / Math.max(1, n));
            }
            log.push({ t: now(), dir: 'audio_start', duration_ms: b ? Math.round(b.duration * 1000) : null, sample_rate: b ? b.sampleRate : null, rms: Number(rms.toFixed(4)), ctx: this.context.state, when: args[0] ? Number(args[0].toFixed(3)) : 0, ctx_time: Number(this.context.currentTime.toFixed(3)) });
        } catch (e) { log.push({ t: now(), dir: 'audio_start_err', message: String(e) }); }
        return nativeStart.apply(this, args);
    };
};

async function main() {
    const wav = path.join(OUT_DIR, 'question.wav');
    if (!fs.existsSync(wav)) throw new Error('question.wav missing (run bridge-probe.js first)');
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME || '/usr/bin/google-chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${wav}`,
            '--autoplay-policy=no-user-gesture-required',
        ],
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(INSTRUMENT);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 160)));
    await page.goto(`${BASE_URL}/lite`, { waitUntil: 'load', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const tClick = await page.evaluate(() => Math.round(performance.now()));
    await page.click('#pttBtn');
    await new Promise((r) => setTimeout(r, 800));
    if (await page.$('#ageGateConfirm') && await page.evaluate(() => { const b = document.getElementById('ageGateConfirm'); return Boolean(b && b.offsetParent); })) {
        await page.click('#ageGateConfirm');
    }
    await new Promise((r) => setTimeout(r, LISTEN_MS));
    const log = await page.evaluate(() => window.__probe);
    const timerText = await page.evaluate(() => (document.querySelector('.voice-session-timer') || {}).textContent || null);
    await browser.close();

    fs.writeFileSync(path.join(OUT_DIR, 'browser-log.json'), JSON.stringify(log, null, 2));
    console.log(`page errors: ${JSON.stringify(pageErrors)}; session timer text at end: ${timerText}`);
    console.log(`timeline (ms since tap):`);
    for (const r of log) console.log(`  ${String(r.t - tClick).padStart(6)}ms ${JSON.stringify({ ...r, t: undefined })}`);

    // Verdict per bridge frame.
    const bridges = log.filter((r) => r.type === 'assistant.bridge');
    if (!bridges.length) console.log('\nVERDICT: no assistant.bridge frame reached the /lite client');
    for (const b of bridges) {
        const expectedMs = Math.round(b.samples / (b.sample_rate || 24000) * 1000);
        const started = log.find((r) => r.dir === 'audio_start' && r.t >= b.t && r.t - b.t < 500 && r.sample_rate === (b.sample_rate || 24000) && Math.abs(r.duration_ms - expectedMs) <= 5);
        const telemetry = log.find((r) => r.dir === 'out' && r.t >= b.t && /bridge_/.test(String(r.stage)));
        console.log(`\nVERDICT bridge "${b.text}" received at ${b.t - tClick}ms (${expectedMs}ms audio): `
            + (started ? `PLAYED — buffer started ${started.t - b.t}ms later, ${started.duration_ms}ms, rms=${started.rms}, AudioContext=${started.ctx}` : 'NOT STARTED')
            + `; client telemetry=${telemetry ? telemetry.stage : 'none'}`);
        if (started) {
            // Answer must be scheduled after the phrase ends (not cut, no overlap).
            const bridgeEnd = started.ctx_time + started.duration_ms / 1000;
            const answer = log.find((r) => r.dir === 'audio_start' && r.t > started.t && r !== started);
            if (answer) console.log(`  answer first buffer scheduled at ctx ${answer.when}s vs bridge end ${bridgeEnd.toFixed(3)}s -> ${answer.when >= bridgeEnd - 0.005 ? 'AFTER the phrase (no overlap)' : 'OVERLAP'}`);
            const stop = log.find((r) => r.dir === 'out' && r.t >= b.t && r.stage === 'bridge_stopped');
            console.log(`  bridge cut before its end: ${stop ? 'YES (' + (stop.t - started.t) + 'ms)' : 'NO'}`);
        }
    }
}

main().catch((error) => { console.error(error); process.exit(1); });

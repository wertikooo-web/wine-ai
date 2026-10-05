'use strict';

// Production check: every service line (30 s warning, session end,
// inactivity check-in / goodbye) x RU/RO/EN comes back pre-rendered in the
// session voice (src/realtime/scriptedLines.js). Lines not rendered yet are
// rendered in the background; the check retries for up to ~2 minutes.
//   ADMIN_TOKEN=... node scripts/diag/scripted-lines.js

const WS = require('ws');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_TOKEN || '';
const KEYS = ['session_warning', 'session_limit', 'inactivity_warning', 'inactivity_goodbye'];
const LANGS = ['ru', 'ro', 'en'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const age = await fetch(`${BASE_URL}/api/age-verification`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) }).then((r) => r.json()).catch(() => ({}));
    const av = age.token ? `&av=${encodeURIComponent(age.token)}` : '';
    const ws = new WS(`${BASE_URL.replace(/^http/, 'ws')}/realtime?channel=lite${av}`, TOKEN ? { headers: { 'x-admin-token': TOKEN } } : undefined);
    const events = [];
    ws.on('message', (d, bin) => { if (!bin) { try { events.push(JSON.parse(d.toString())); } catch { /* ignore */ } } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(50); } return null; };
    await waitFor((e) => e.type === 'session.ready', 10000);
    ws.send(JSON.stringify({ type: 'session.start', sampleRate: 16000, language: 'ru' }));
    await waitFor((e) => e.type === 'provider.ready', 20000);
    let missing = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
        missing = [];
        const rows = [];
        for (const lang of LANGS) {
            for (const key of KEYS) {
                const id = `${attempt}_${lang}_${key}`;
                ws.send(JSON.stringify({ type: 'scripted_line.request', key, lang, request_id: id }));
                const e = await waitFor((x) => x.type === 'assistant.scripted_line' && x.request_id === id, 5000);
                const bytes = e && e.audio_base64 ? Buffer.from(e.audio_base64, 'base64').length : 0;
                const secs = bytes && e.sample_rate ? (bytes / 2 / e.sample_rate).toFixed(1) : '-';
                rows.push(`${lang} ${key.padEnd(18)} audio=${bytes ? `${secs}s` : 'NONE'} | ${e ? e.text : 'NO REPLY'}`);
                if (!bytes) missing.push(`${lang}/${key}`);
            }
        }
        if (!missing.length || attempt === 8) { console.log(`attempt ${attempt}:`); rows.forEach((r) => console.log(`  ${r}`)); break; }
        console.log(`attempt ${attempt}: ${missing.length} not rendered yet, retry in 15 s`);
        await sleep(15000);
    }
    ws.close();
    console.log(missing.length ? `\nFAIL: missing ${missing.join(', ')}` : '\nOK: all 12 service lines pre-rendered');
    process.exit(missing.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });

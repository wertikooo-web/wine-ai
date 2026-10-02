'use strict';

// Production acceptance for temporary Lite guest access (docs/LITE_ACCESS.md).
// Creates its own short-lived codes through the admin API and deletes them at
// the end. Cases A-J + "Dashboard unaffected" + "voice unaffected" (one real
// guest conversation turn over the Lite WebSocket).
//
//   ADMIN_TOKEN=... node scripts/diag/lite-access-acceptance.js

const WS = require('ws');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const TOKEN = process.env.ADMIN_TOKEN || '';
const admin = { 'x-admin-token': TOKEN, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const created = [];

function check(cond, label) {
    results.push({ ok: Boolean(cond), label });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
}

async function createCode(label, body) {
    const r = await (await fetch(`${BASE_URL}/api/lite-access/codes`, { method: 'POST', headers: admin, body: JSON.stringify({ label: `acceptance: ${label}`, ...body }) })).json();
    if (r.ok) created.push(r.entry.id);
    return r;
}

async function login(code, ip) {
    const r = await fetch(`${BASE_URL}/api/lite/access`, { method: 'POST', headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) }, body: JSON.stringify({ code }) });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

const get = (path, headers = {}) => fetch(`${BASE_URL}${path}`, { headers, redirect: 'manual' });

function wsOpen(path, headers = {}) {
    return new Promise((resolve) => {
        const ws = new WS(`${WS_BASE}${path}`, { headers });
        const events = [];
        let settled = false;
        ws.on('message', (data, isBinary) => { if (!isBinary) { try { events.push(JSON.parse(data.toString())); } catch { /* ignore */ } } else events.push({ type: '__audio' }); });
        ws.on('open', () => { settled = true; resolve({ ok: true, ws, events }); });
        ws.on('unexpected-response', (req, res) => { if (!settled) { settled = true; resolve({ ok: false, status: res.statusCode }); } });
        ws.on('error', () => { if (!settled) { settled = true; resolve({ ok: false, status: 'error' }); } });
    });
}

async function waitFor(events, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = events.find(predicate);
        if (hit) return hit;
        await sleep(100);
    }
    return null;
}

async function main() {
    if (!TOKEN) throw new Error('ADMIN_TOKEN required');

    // anonymous -> LOCKED (G, H)
    check((await get('/api/lite/access')).status === 401, 'G: anonymous has no Lite session');
    check((await get('/api/lite/config')).status === 401, 'H: anonymous /api/lite/config -> 401');
    check((await get('/api/companion/catalog')).status === 401, 'H: anonymous Visual Companion -> 401');
    const anonWs = await wsOpen('/realtime?channel=lite');
    check(!anonWs.ok && anonWs.status === 401, `H: anonymous Lite WebSocket -> ${anonWs.status}`);
    const page = await (await get('/lite')).text();
    check(/__wineAiLiteAccessToken/.test(page), 'anonymous /lite page is gated (access gate present)');
    check((await get('/lite/access')).status === 200, 'access screen served');

    // A: TEST20-style code, 20 min
    const a = await createCode('A 20min', { expires_in_minutes: 20 });
    check(a.ok, 'A: admin created a 20-minute code');
    const la = await login(a.code);
    check(la.status === 200 && la.cookie, 'A: valid code -> WORKS');
    check((await get('/api/lite/access', { cookie: la.cookie })).status === 200, 'F: same session on reload');
    check((await get('/api/lite/config', { cookie: la.cookie })).status === 200, 'guest reads Lite config');

    // B: wrong code
    const lb = await login('WRONG-CODE-1', '198.51.100.7');
    check(lb.status === 401 && lb.body.error === 'invalid_code' && !lb.cookie, 'B: wrong code -> DENIED');

    // E: second code at the same time
    const e = await createCode('E second', { expires_in_minutes: 60 });
    const le = await login(e.code);
    check(le.status === 200 && (await get('/api/lite/config', { cookie: le.cookie })).status === 200, 'E: two codes work simultaneously');

    // I: guest is not admin
    for (const path of ['/api/persona', '/api/cost/summary', '/api/lite-access/codes', '/api/knowledge/status']) {
        check((await get(path, { cookie: la.cookie })).status === 401, `I: guest -> ${path} 401`);
    }
    check((await get('/dashboard', { cookie: la.cookie })).status === 302, 'I: guest -> /dashboard -> login');

    // voice unaffected: one real guest turn
    const guestWs = await wsOpen('/realtime?channel=lite', { cookie: la.cookie });
    check(guestWs.ok, 'guest Lite WebSocket opens');
    if (guestWs.ok) {
        await waitFor(guestWs.events, (ev) => ev.type === 'session.ready', 10000);
        guestWs.ws.send(JSON.stringify({ type: 'session.start', sampleRate: 16000, language: 'ru' }));
        await waitFor(guestWs.events, (ev) => ev.type === 'provider.ready', 20000);
        const t0 = Date.now();
        guestWs.ws.send(JSON.stringify({ type: 'input_text.submit', text: 'Привет! Как тебя зовут?' }));
        const audio = await waitFor(guestWs.events, (ev) => ev.type === 'audio.delta' || ev.type === 'audio.chunk' || ev.type === '__audio', 30000);
        const done = await waitFor(guestWs.events, (ev) => ['audio.end', 'response.done'].includes(ev.type), 45000);
        const answer = guestWs.events.filter((ev) => ev.type === 'transcript.model').map((ev) => ev.text).join('').trim();
        check(audio && done, `voice: guest turn answered with audio (first audio ${audio ? Date.now() - t0 : '-'} ms) — "${answer.slice(0, 80)}"`);

        // D + J: revoke while the session is open
        const revoke = await fetch(`${BASE_URL}/api/lite-access/codes/${a.entry.id}/revoke`, { method: 'POST', headers: admin });
        check(revoke.status === 200, 'D: admin revoked code A');
        check((await get('/api/lite/config', { cookie: la.cookie })).status === 401, 'D: revoked -> LOCKED immediately');
        check((await login(a.code, '198.51.100.8')).status === 401, 'D: revoked code cannot log in');
        const ended = await waitFor(guestWs.events, (ev) => ev.type === 'session.ended', 40000);
        check(ended && ended.reason === 'access_expired', `J: open session ended (${ended ? ended.reason : 'no event in 40 s'})`);
        try { guestWs.ws.close(); } catch { /* closed */ }
    }
    check((await get('/api/lite/config', { cookie: le.cookie })).status === 200, 'E: other code unaffected by the revoke');

    // C: expired code (1-minute lifetime)
    const c = await createCode('C 1min', { expires_in_minutes: 1 });
    const lc = await login(c.code);
    check(lc.status === 200, 'C: 1-minute code works before expiry');
    console.log('waiting 65 s for the 1-minute code to expire…');
    await sleep(65000);
    check((await login(c.code, '198.51.100.9')).status === 401, 'C: expired code -> LOCKED');
    check((await get('/api/lite/config', { cookie: lc.cookie })).status === 401, 'J: session of the expired code -> LOCKED');

    // Dashboard unaffected
    check((await get('/api/persona', { 'x-admin-token': TOKEN })).status === 200, 'Dashboard API unaffected (admin)');
    check((await get('/dashboard', { 'x-admin-token': TOKEN })).status === 200, 'Dashboard page unaffected (admin)');
    const list = await (await get('/api/lite-access/codes', { 'x-admin-token': TOKEN })).json();
    check(list.ok && !JSON.stringify(list).includes(e.code), 'code list never shows codes');
}

main()
    .catch((error) => { check(false, `error: ${error.message}`); })
    .finally(async () => {
        for (const id of created) await fetch(`${BASE_URL}/api/lite-access/codes/${id}`, { method: 'DELETE', headers: admin }).catch(() => {});
        const failed = results.filter((r) => !r.ok);
        console.log(`\nVERDICT ${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length}`);
        failed.forEach((f) => console.log(`  - ${f.label}`));
        process.exit(failed.length ? 1 : 0);
    });

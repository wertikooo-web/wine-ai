'use strict';

// Temporary guest access to Wine AI Lite (src/security/liteAccess.js,
// docs/LITE_ACCESS.md). Unit: hashing, expiry, revocation, independent codes,
// signed sessions, rate limit, uniform errors. End-to-end against the real
// server with LITE_ACCESS_ENFORCED=1: the acceptance cases A-J.

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');
const { connect } = require('./helpers/wsTestClient');
const {
    createLiteAccess, createMemoryLiteAccessStore, hashCode, verifyCodeHash, normalizeCode, generateCode, renderAccessPage, COOKIE_NAME,
} = require('../src/security/liteAccess');
const { classifyRoute } = require('../src/security/adminAuth');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reqFrom = (ip, extra = {}) => ({ headers: { 'x-forwarded-for': ip, ...extra }, socket: { remoteAddress: ip } });

async function unit() {
    const hash = await hashCode('ABCD2345');
    t.ok(/^scrypt\$16384\$/.test(hash) && !hash.includes('ABCD2345'), 'code stored as a salted scrypt hash, never plaintext');
    t.ok(await verifyCodeHash('ABCD2345', hash), 'hash verifies the right code');
    t.ok(!(await verifyCodeHash('ABCD2346', hash)), 'and rejects a wrong one');
    t.ok(hash !== await hashCode('ABCD2345'), 'salted: same code, different hash');
    t.equal(normalizeCode(' tv8 interview '), 'TV8INTERVIEW', 'case and spaces ignored');
    t.ok(/^[A-HJ-NP-Z2-9]{8}$/.test(generateCode()), 'generated code: 8 easy-to-dictate characters');

    let clock = Date.parse('2026-10-02T09:00:00Z');
    const logs = [];
    const access = createLiteAccess({
        store: createMemoryLiteAccessStore(),
        env: { LITE_ACCESS_ENFORCED: '1', LITE_ACCESS_SECRET: 'unit-secret', LITE_ACCESS_MAX_FAILURES: '4' },
        now: () => clock,
        log: (stage, extra) => logs.push({ stage, ...extra }),
    });
    t.equal(access.enforced, true);

    // A: 20-minute code
    const a = await access.createCode({ label: 'TV8 interview', code: 'test20', expiresInMinutes: 20 });
    t.ok(a.ok && a.code === 'TEST20' && a.entry.status === 'ACTIVE' && !('code_hash' in a.entry), 'created; code returned once, hash never exposed');
    const loginA = await access.login(reqFrom('1.1.1.1'), 'Test20');
    t.ok(loginA.ok && loginA.token && /HttpOnly/.test(loginA.cookie) && /SameSite=Lax/.test(loginA.cookie), 'A: login works, HttpOnly SameSite cookie');
    t.ok(!loginA.token.includes('TEST20') && !loginA.cookie.includes('TEST20'), 'the session never carries the code');
    t.equal((await access.checkToken(loginA.token)).ok, true, 'A: session valid');

    // B: wrong code, uniform error, no code in logs
    const wrong = await access.login(reqFrom('2.2.2.2'), 'NOPE99');
    t.ok(!wrong.ok && wrong.status === 401 && wrong.error === 'invalid_code', 'B: wrong code denied');
    t.ok(!JSON.stringify(logs).includes('NOPE99') && !JSON.stringify(logs).includes('TEST20'), 'codes never logged');

    // E: two codes independent
    const e = await access.createCode({ label: 'Winery X', code: 'WINERYX1', expiresInMinutes: 24 * 60 });
    const loginE = await access.login(reqFrom('1.1.1.1'), 'winery x1');
    t.ok(e.ok && loginE.ok, 'E: second code works alongside the first');
    t.equal((await access.createCode({ label: 'dup', code: 'TEST20', expiresInMinutes: 5 })).errors[0], 'code_already_active', 'the same active code cannot be created twice');

    // 09:19 valid, 09:20 expired (C + J for an open session)
    clock += 19 * 60 * 1000;
    t.equal((await access.checkToken(loginA.token)).ok, true, '09:19 still valid');
    clock += 60 * 1000 + 5000;
    const expired = await access.checkToken(loginA.token);
    t.ok(!expired.ok && expired.reason === 'lite_access_expired', '09:20 open session expired (J)');
    t.equal((await access.isGrantActive(a.entry.id, loginA.expiresAt)), false, 'open WebSocket sessions see it as inactive');
    const expiredLogin = await access.login(reqFrom('3.3.3.3'), 'TEST20');
    t.ok(!expiredLogin.ok && expiredLogin.error === 'invalid_code', 'C: expired code denied with the same answer as a wrong one');
    t.equal((await access.checkToken(loginE.token)).ok, true, 'the other code is unaffected by the first one expiring');

    // D: revoke immediately
    t.ok(await access.revokeCode(e.entry.id), 'revoked');
    t.equal((await access.checkToken(loginE.token)).ok, false, 'D: revoked -> open session loses access at once (cache invalidated)');
    t.equal((await access.login(reqFrom('4.4.4.4'), 'WINERYX1')).ok, false, 'D: revoked code cannot log in');
    const listed = await access.listCodes();
    t.deepEqual(listed.map((c) => c.status).sort(), ['EXPIRED', 'REVOKED'], 'statuses EXPIRED / REVOKED');
    t.ok(listed.every((c) => !('code_hash' in c)), 'list never exposes hashes');
    t.ok(await access.deleteCode(e.entry.id) && (await access.listCodes()).length === 1, 'delete removes the record');

    // tampered / foreign tokens
    const f = await access.createCode({ label: 'F', expiresInMinutes: 60 });
    const loginF = await access.login(reqFrom('5.5.5.5'), f.code);
    const [payload, sig] = loginF.token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, g: f.entry.id, e: clock + 999999999, n: 'x' })).toString('base64url');
    t.equal((await access.checkToken(`${forged}.${sig}`)).ok, false, 'forged expiry rejected (signature)');
    t.equal((await access.checkToken(`${payload}.${sig}x`)).ok, false, 'bad signature rejected');
    const other = createLiteAccess({ store: createMemoryLiteAccessStore(), env: { LITE_ACCESS_ENFORCED: '1', LITE_ACCESS_SECRET: 'other' }, now: () => clock });
    t.equal((await other.checkToken(loginF.token)).ok, false, 'token from another secret rejected');
    t.equal((await access.checkRequest({ headers: { cookie: `${COOKIE_NAME}=${encodeURIComponent(loginF.token)}` } })).ok, true, 'cookie transport');
    t.equal((await access.checkRequest({ headers: { 'x-lite-access': loginF.token } })).ok, true, 'header transport (iframe)');
    t.equal((await access.checkRequest({ headers: {}, url: `/realtime?channel=lite&la=${encodeURIComponent(loginF.token)}` })).ok, true, 'WebSocket query transport');
    t.equal((await access.checkRequest({ headers: {} })).reason, 'lite_access_required', 'no session -> required');

    // rate limit per IP
    for (let i = 0; i < 4; i += 1) await access.login(reqFrom('9.9.9.9'), `BAD00${i}`);
    const limited = await access.login(reqFrom('9.9.9.9'), f.code);
    t.ok(limited.status === 429 && limited.retryAfter > 0, 'rate-limited after repeated failures (even the right code)');
    t.equal((await access.login(reqFrom('8.8.8.8'), f.code)).ok, true, 'other IPs unaffected');

    // validation
    t.ok((await access.createCode({ label: '', expiresInMinutes: 20 })).errors.includes('label_required'), 'label required');
    t.ok((await access.createCode({ label: 'x', code: 'abc', expiresInMinutes: 20 })).errors.includes('code_length_6_64'), 'short code refused');
    t.ok((await access.createCode({ label: 'x', expiresAt: new Date(clock - 1000).toISOString() })).errors.includes('expiry_in_future_required'), 'past expiry refused');
    t.ok((await access.createCode({ label: 'x', expiresInMinutes: 60 * 24 * 40 })).errors.includes('expiry_max_31_days'), 'over 31 days refused');

    // enforcement switch
    t.equal(createLiteAccess({ store: createMemoryLiteAccessStore(), production: true, env: {} }).enforced, true, 'enforced in production by default');
    t.equal(createLiteAccess({ store: createMemoryLiteAccessStore(), production: true, env: { LITE_ACCESS_ENFORCED: '0' } }).enforced, false, 'LITE_ACCESS_ENFORCED=0 reopens (rollback)');
    t.equal(createLiteAccess({ store: createMemoryLiteAccessStore(), env: {} }).enforced, false, 'local dev: open');

    // routes
    t.equal(classifyRoute('POST', '/api/lite/access'), 'public', 'guest login is public');
    t.equal(classifyRoute('GET', '/lite/access'), 'public', 'access screen is public');
    for (const [m, p] of [['GET', '/api/lite-access/codes'], ['POST', '/api/lite-access/codes'], ['POST', '/api/lite-access/codes/lac_abc123/revoke'], ['DELETE', '/api/lite-access/codes/lac_abc123']]) {
        t.equal(classifyRoute(m, p), 'admin', `${m} ${p} is admin-only`);
    }
    const page = renderAccessPage();
    t.ok(/WINE AI/.test(page) && /Введите код доступа/.test(page) && /Introduceți codul de acces/.test(page) && /Enter access code/.test(page), 'access screen RU/RO/EN');
    t.ok(/Неверный или недействительный код доступа\./.test(page) && /Срок тестового доступа закончился\./.test(page), 'access screen messages');
    t.ok(!/localStorage/.test(page), 'nothing in localStorage');
    t.ok(/translate="no"/.test(page) && /notranslate/.test(page), 'access screen is never machine-translated');
    const lite = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    t.ok(/<html lang="ru" translate="no">/.test(lite) && /<meta name="google" content="notranslate">/.test(lite), 'Lite page is never machine-translated (Chrome turned Romanian answers into Russian)');
}

async function endToEnd() {
    const port = 19200 + Math.floor(Math.random() * 50);
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: ROOT,
        env: {
            ...process.env, PORT: String(port), DATABASE_URL: 'memory', GEMINI_API_KEY: 'test-placeholder', REALTIME_PROVIDER: 'mock',
            ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct horse battery', ADMIN_TOKEN: 'ci-token-123',
            LITE_ACCESS_ENFORCED: '1', LITE_ACCESS_CHECK_MS: '1000',
            RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_ENVIRONMENT: '', RAILWAY_PROJECT_ID: '', NODE_ENV: 'test',
        },
        stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const req = (p, options = {}) => fetch(base + p, { redirect: 'manual', ...options });
    const admin = { 'x-admin-token': 'ci-token-123', 'content-type': 'application/json' };
    const json = (body) => JSON.stringify(body);
    const upgrade = (p, headers = {}) => new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port, path: p, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
        r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
        r.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        r.on('error', () => resolve('error'));
        r.end();
    });
    try {
        for (let i = 0; i < 60; i += 1) { try { await fetch(base + '/health'); break; } catch { await sleep(250); } }

        // G/H: anonymous -> locked
        t.equal((await req('/api/lite/access')).status, 401, 'anonymous: no Lite session');
        t.equal((await req('/api/lite/config')).status, 401, 'H: /api/lite/config locked');
        t.equal((await req('/api/companion/catalog')).status, 401, 'H: Visual Companion data locked');
        t.equal((await req('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ confirmed: true }) })).status, 401, 'H: age verification locked');
        t.equal(await upgrade('/realtime?channel=lite'), 401, 'H: anonymous Lite WebSocket -> 401');
        const accessPage = await req('/lite/access');
        t.ok(accessPage.status === 200 && /Enter access code/.test(await accessPage.text()), 'access screen served');
        t.ok(/__wineAiLiteAccessToken/.test(await (await req('/lite')).text()), 'G: /lite page carries the access gate');

        // admin creates codes (only the admin can)
        t.equal((await req('/api/lite-access/codes')).status, 401, 'anonymous cannot list codes');
        t.equal((await req('/api/lite-access/codes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ label: 'x', expires_in_minutes: 20 }) })).status, 401, 'anonymous cannot create codes');
        const created = await (await req('/api/lite-access/codes', { method: 'POST', headers: admin, body: json({ label: 'TV8', code: 'TEST20', expires_in_minutes: 20 }) })).json();
        t.ok(created.ok && created.code === 'TEST20', 'A: admin creates TEST20 (20 min)');
        const second = await (await req('/api/lite-access/codes', { method: 'POST', headers: admin, body: json({ label: 'Journalist', expires_in_minutes: 60 }) })).json();
        t.ok(second.ok && /^[A-Z0-9]{8}$/.test(second.code), 'generated code');

        // B: wrong code
        const bad = await req('/api/lite/access', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.1.1.1' }, body: json({ code: 'WRONG1' }) });
        t.equal(bad.status, 401, 'B: wrong code denied');
        t.ok(!bad.headers.get('set-cookie'), 'no cookie on failure');

        // A: login
        const login = await req('/api/lite/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ code: 'test20' }) });
        const loginBody = await login.json();
        t.ok(login.status === 200 && loginBody.ok && loginBody.token, 'A: TEST20 login PASS');
        const cookie = login.headers.get('set-cookie').split(';')[0];
        t.ok(/HttpOnly/.test(login.headers.get('set-cookie')), 'HttpOnly cookie');
        // F: "refresh" = same cookie again
        t.equal((await req('/api/lite/access', { headers: { cookie } })).status, 200, 'F: session persists across reloads');
        t.equal((await req('/api/lite/config', { headers: { cookie } })).status, 200, 'guest reads Lite config');
        t.equal((await req('/api/lite/config', { headers: { 'x-lite-access': loginBody.token } })).status, 200, 'iframe header transport works');
        t.equal(await upgrade('/realtime?channel=lite', { cookie }), 101, 'guest Lite WebSocket opens');

        // I: the guest is not an admin
        for (const p of ['/api/persona', '/api/cost/summary', '/api/lite-access/codes', '/api/knowledge/status', '/api/live-test/state']) {
            t.equal((await req(p, { headers: { cookie } })).status, 401, `I: guest -> ${p} 401`);
        }
        t.equal((await req('/dashboard', { headers: { cookie } })).status, 302, 'I: guest -> /dashboard redirected to login');
        t.equal(await upgrade('/realtime?provider=mock', { cookie }), 401, 'I: guest cannot open the operator channel');

        // E: second code independently
        const login2 = await req('/api/lite/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ code: second.code }) });
        const cookie2 = login2.headers.get('set-cookie').split(';')[0];
        t.equal(login2.status, 200, 'E: second code logs in');

        // J + D: an open session ends when its code is revoked; the other stays
        const client = await connect(port, '/realtime?channel=lite', { cookie });
        await client.waitFor((e) => e.type === 'session.ready', { timeoutMs: 5000 });
        const revoke = await req(`/api/lite-access/codes/${created.entry.id}/revoke`, { method: 'POST', headers: admin });
        t.equal(revoke.status, 200, 'D: admin revokes TEST20');
        t.equal((await req('/api/lite/config', { headers: { cookie } })).status, 401, 'D: revoked -> denied immediately');
        const ended = await client.waitFor((e) => e.type === 'session.ended', { timeoutMs: 6000, label: 'session.ended' });
        t.equal(ended.reason, 'access_expired', 'J: open Lite session closed with access_expired');
        client.close();
        t.equal((await req('/api/lite/access', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.2.2.2' }, body: json({ code: 'TEST20' }) })).status, 401, 'D: revoked code cannot log in again');
        t.equal((await req('/api/lite/config', { headers: { cookie: cookie2 } })).status, 200, 'E: the other code is unaffected');

        // admin bypass + Dashboard unaffected
        t.equal((await req('/api/lite/config', { headers: admin })).status, 200, 'admin uses Lite without a code');
        t.equal(await upgrade('/realtime?channel=lite', { 'x-admin-token': 'ci-token-123' }), 101, 'admin Lite WebSocket opens (diagnostics)');
        const list = await (await req('/api/lite-access/codes', { headers: admin })).json();
        t.deepEqual(list.codes.map((c) => c.status).sort(), ['ACTIVE', 'REVOKED'], 'Dashboard list shows ACTIVE / REVOKED');
        t.ok(!JSON.stringify(list).includes('TEST20'), 'list never shows codes');
        t.equal((await req(`/api/lite-access/codes/${created.entry.id}`, { method: 'DELETE', headers: admin })).status, 200, 'delete');
    } finally {
        server.kill();
    }
}

async function run() {
    await unit();
    await endToEnd();
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('liteAccess tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

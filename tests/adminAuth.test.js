'use strict';

// Admin authentication before the public /lite launch (docs/ADMIN_AUTH.md).
// Unit: route matrix, production fail-closed, cookie flags, rate limit.
// End-to-end against the real server: /lite and its runtime stay public,
// admin pages redirect to /login, admin APIs answer 401, login/logout work,
// the dashboard can change configuration when logged in, and the full
// persona prompt never reaches an anonymous realtime client.

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const t = require('./helpers/assertions');
const { classifyRoute, createAdminAuth, safeNext } = require('../src/security/adminAuth');
const { connect } = require('./helpers/wsTestClient');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function unit() {
    const matrix = [
        ['GET', '/lite', 'public'], ['GET', '/api/lite/config', 'public'], ['GET', '/wine-ai-widget.js', 'public'],
        ['GET', '/lite-companion.js', 'public'], ['GET', '/persona-assets/maria.png', 'public'], ['GET', '/persona-avatar/warm_guide', 'public'],
        ['GET', '/api/age-verification', 'public'], ['POST', '/api/age-verification', 'public'], ['GET', '/api/companion/catalog', 'public'],
        ['GET', '/api/companion/wines/cw_abcd1234', 'public'], ['POST', '/api/live-test/feedback', 'public'],
        ['POST', '/api/analytics/session-end', 'public'], ['POST', '/api/analytics/purchase-click', 'public'], ['GET', '/health', 'public'],
        ['GET', '/visual-assets/visual-story.css', 'public'], ['GET', '/login', 'public'], ['POST', '/login', 'public'], ['POST', '/logout', 'public'],
        ['GET', '/', 'admin'], ['GET', '/dashboard', 'admin'], ['GET', '/dashboard/cost-guide', 'admin'], ['GET', '/knowledge-studio', 'admin'],
        ['GET', '/answer-audit', 'admin'], ['GET', '/audit', 'admin'], ['GET', '/avatar-lab', 'admin'], ['GET', '/avatar-dev', 'admin'],
        ['GET', '/visual-modules/debug/avatar-debug.html', 'admin'],
        ['GET', '/api/persona', 'admin'], ['POST', '/api/persona', 'admin'], ['POST', '/api/persona/activate', 'admin'], ['GET', '/api/persona/profiles', 'admin'],
        ['GET', '/api/voices', 'admin'], ['POST', '/api/voice-preview', 'admin'],
        ['GET', '/api/live-test/state', 'admin'], ['POST', '/api/live-test/publish', 'admin'], ['POST', '/api/live-test/baseline', 'admin'],
        ['GET', '/api/companion/wines', 'admin'], ['POST', '/api/companion/wines/import', 'admin'], ['POST', '/api/companion/wines/cw_abcd1234/published', 'admin'],
        ['GET', '/api/cost/summary', 'admin'], ['POST', '/api/cost/settings', 'admin'],
        ['GET', '/api/knowledge/status', 'admin'], ['POST', '/api/knowledge/upload', 'admin'], ['POST', '/api/knowledge/reindex', 'admin'],
        ['DELETE', '/api/knowledge/sources/a.md', 'admin'], ['PATCH', '/api/knowledge/sources/a.md', 'admin'],
        ['POST', '/api/kos/sources/website', 'admin'], ['POST', '/api/kos/wines/extract', 'admin'],
        ['GET', '/api/screen-context/wine/x', 'admin'], ['GET', '/api/some-future-endpoint', 'admin'], ['POST', '/lite', 'admin'],
    ];
    for (const [method, route, expected] of matrix) t.equal(classifyRoute(method, route), expected, `${method} ${route} -> ${expected}`);

    t.equal(safeNext('//evil.example'), '/dashboard', 'no open redirect (//host)');
    t.equal(safeNext('https://evil.example'), '/dashboard', 'no open redirect (absolute)');
    t.equal(safeNext('/lite'), '/dashboard', 'next must be an admin page');
    t.equal(safeNext('/knowledge-studio'), '/knowledge-studio');

    const prodNoPassword = createAdminAuth({ env: { RAILWAY_ENVIRONMENT_NAME: 'production' } });
    t.equal(prodNoPassword.enforced, true, 'production without ADMIN_PASSWORD: enforced (fail closed)');
    t.equal(prodNoPassword.isAdminRequest({ headers: {} }), false, 'production without ADMIN_PASSWORD: nobody is admin');
    t.equal(prodNoPassword.login({ headers: {}, socket: {} }, { username: 'admin', password: '' }).status, 503, 'and login is unavailable');
    t.equal(createAdminAuth({ env: {} }).enforced, false, 'local dev without a password: open as before');

    const prod = createAdminAuth({ env: { RAILWAY_ENVIRONMENT_NAME: 'production', ADMIN_PASSWORD: 's3cret-pass' } });
    const ok = prod.login({ headers: {}, socket: { remoteAddress: '1.1.1.1' } }, { username: 'admin', password: 's3cret-pass' });
    t.ok(ok.ok && /HttpOnly/.test(ok.cookie) && /SameSite=Lax/.test(ok.cookie) && /; Secure/.test(ok.cookie) && /Max-Age=43200/.test(ok.cookie), 'production cookie: HttpOnly, SameSite=Lax, Secure, 12 h');

    let clock = 0;
    const expiring = createAdminAuth({ env: { ADMIN_PASSWORD: 'p' }, now: () => clock });
    const session = expiring.login({ headers: {}, socket: { remoteAddress: '2.2.2.2' } }, { username: 'admin', password: 'p' });
    const cookieValue = session.cookie.split(';')[0];
    t.equal(expiring.isAdminRequest({ headers: { cookie: cookieValue } }), true, 'session valid');
    clock += 12 * 60 * 60 * 1000 + 1;
    t.equal(expiring.isAdminRequest({ headers: { cookie: cookieValue } }), false, 'session expires');
}

async function endToEnd() {
    const port = 19100 + Math.floor(Math.random() * 50);
    const server = spawn(process.execPath, ['src/server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), DATABASE_URL: 'memory', GEMINI_API_KEY: 'test-placeholder', REALTIME_PROVIDER: 'mock', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'correct horse battery', ADMIN_TOKEN: 'ci-token-123', ADMIN_LOGIN_MAX_FAILURES: '3', RAILWAY_ENVIRONMENT_NAME: '', RAILWAY_ENVIRONMENT: '', RAILWAY_PROJECT_ID: '', NODE_ENV: 'test' },
        stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    const req = (p, options = {}) => fetch(base + p, { redirect: 'manual', ...options });
    try {
        for (let i = 0; i < 60; i += 1) { try { await fetch(base + '/health'); break; } catch { await sleep(250); } }

        // 1. public runtime
        t.equal((await req('/lite')).status, 200, 'incognito /lite opens');
        const liteConfig = await (await req('/api/lite/config')).json();
        t.ok(liteConfig.ok && liteConfig.free_conversation_session_limit_ms > 0 && liteConfig.tap_to_start_idle_timeout_ms > 0, '/api/lite/config public, carries the session limit');
        t.ok(!/system_prompt|personality_prompt/.test(JSON.stringify(liteConfig)), 'no prompts in the public config');
        for (const p of ['/wine-ai-widget.js', '/lite-companion.js', '/persona-assets/fallback.svg', '/api/companion/catalog', '/health']) {
            t.equal((await req(p)).status, 200, `public ${p}`);
        }
        const age = await (await req('/api/age-verification', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })).json();
        t.ok(age.ok !== false, 'age verification public');
        t.ok((await req('/api/live-test/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status !== 401, 'participant rating is not blocked by auth');

        // 2. admin pages -> /login
        for (const p of ['/dashboard', '/', '/knowledge-studio', '/answer-audit', '/avatar-lab', '/avatar-dev', '/dashboard/cost-guide']) {
            const r = await req(p);
            t.equal(r.status, 302, `anonymous ${p} redirected`);
            t.ok(r.headers.get('location').startsWith('/login?next='), `${p} -> /login`);
        }
        const loginPage = await req('/login?next=%2Fdashboard');
        t.equal(loginPage.status, 200);
        t.ok(/name="password"/.test(await loginPage.text()), 'login form');

        // 5. admin APIs -> 401
        const denied = [
            ['GET', '/api/persona'], ['POST', '/api/persona'], ['POST', '/api/persona/activate'], ['GET', '/api/persona/profiles'],
            ['GET', '/api/voices'], ['POST', '/api/voice-preview'], ['GET', '/api/live-test/state'], ['POST', '/api/live-test/publish'],
            ['GET', '/api/cost/summary'], ['POST', '/api/cost/settings'], ['GET', '/api/knowledge/status'], ['POST', '/api/knowledge/upload'],
            ['POST', '/api/knowledge/reindex'], ['DELETE', '/api/knowledge/sources/x.md'], ['POST', '/api/kos/sources/website'],
            ['GET', '/api/companion/wines'], ['POST', '/api/companion/wines/import'], ['GET', '/api/whatever'],
        ];
        for (const [method, p] of denied) {
            const r = await req(p, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
            t.equal(r.status, 401, `anonymous ${method} ${p} -> 401`);
            t.equal(r.headers.get('cache-control'), 'no-store');
        }

        // 3. wrong password, rate limit (separate client IP)
        const form = (u, p, next = '/dashboard', ip = '10.0.0.1') => req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams({ username: u, password: p, next }).toString() });
        const wrong = await form('admin', 'nope');
        t.equal(wrong.status, 401, 'wrong password rejected');
        t.ok(!wrong.headers.get('set-cookie'), 'no session cookie on failure');
        for (let i = 0; i < 3; i += 1) await form('admin', 'nope', '/dashboard', '10.9.9.9');
        const limited = await form('admin', 'correct horse battery', '/dashboard', '10.9.9.9');
        t.equal(limited.status, 429, 'failed logins rate-limited (even the right password is refused while locked)');
        t.ok(Number(limited.headers.get('retry-after')) > 0, 'Retry-After');
        const spoofed = await form('admin', 'correct horse battery', '/dashboard', '1.2.3.4, 10.9.9.9');
        t.equal(spoofed.status, 429, 'a client-supplied leftmost X-Forwarded-For does not reset the limit');

        // 4. correct credentials, open-redirect guard
        const good = await form('admin', 'correct horse battery', '//evil.example');
        t.equal(good.status, 303, 'login ok');
        t.equal(good.headers.get('location'), '/dashboard', 'unsafe next ignored');
        const setCookie = good.headers.get('set-cookie');
        t.ok(/HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), 'HttpOnly + SameSite cookie');
        const cookie = setCookie.split(';')[0];
        const dash = await req('/dashboard', { headers: { cookie } });
        t.equal(dash.status, 200, 'dashboard opens after login');
        t.equal(dash.headers.get('cache-control'), 'no-store', 'admin page not cached');
        // (the persona store itself may be unavailable without a database: 503 is not an auth failure)
        t.ok((await req('/api/persona', { headers: { cookie } })).status !== 401, 'admin API passes the gate when logged in');
        t.equal((await req('/api/cost/summary', { headers: { cookie } })).status, 200, 'admin API readable when logged in');

        // 6. configuration change works when logged in
        const publish = await req('/api/live-test/publish', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ config: { provider: 'gemini', voice: 'Kore', persona: 'warm_guide', mood: 'warm', responseLength: 'balanced', tone: 'warm', expertiseLevel: 'balanced', conversationMode: 'friendly', knowledgeMode: 'database_only' } }) });
        t.equal(publish.status, 200, 'logged-in dashboard can change configuration');
        t.equal((await publish.json()).ok, true);
        t.equal((await req('/api/live-test/state', { headers: { 'x-admin-token': 'ci-token-123' } })).status, 200, 'ADMIN_TOKEN header still works for scripts/CI');
        t.equal((await req('/api/live-test/state', { headers: { 'x-admin-token': 'wrong' } })).status, 401, 'wrong token rejected');

        // realtime: anonymous /lite gets no prompt text; admin does
        const avToken = age.token || age.adult_token || '';
        const promptBlocks = async (headers) => {
            const client = await connect(port, `/realtime?channel=lite${avToken ? `&av=${encodeURIComponent(avToken)}` : ''}`, headers);
            try {
                await client.waitFor((e) => e.type === 'session.ready');
                client.sendJson({ type: 'session.start', sampleRate: 16000, include_prompt_debug: true });
                const applied = await client.waitFor((e) => e.type === 'session.config.applied', { timeoutMs: 8000 });
                return applied.prompt_debug && applied.prompt_debug.applied_blocks;
            } finally { client.close(); }
        };
        t.ok(!(await promptBlocks({})), 'anonymous realtime client never receives the persona prompt');
        const adminBlocks = await promptBlocks({ cookie });
        t.ok(adminBlocks && typeof adminBlocks.persona === 'string' && adminBlocks.persona.length > 100, 'admin diagnostics still get it');

        // realtime operator channel (no channel=lite: provider choice,
        // Settings persona) is admin-only; /lite channel stays public
        const upgradeStatus = (headers = {}) => new Promise((resolve) => {
            const r = http.request({ host: '127.0.0.1', port, path: '/realtime?provider=mock', headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
            r.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
            r.on('response', (res) => { res.resume(); resolve(res.statusCode); });
            r.on('error', () => resolve('error'));
            r.end();
        });
        t.equal(await upgradeStatus(), 401, 'anonymous operator realtime channel -> 401');
        t.equal(await upgradeStatus({ cookie }), 101, 'admin operator realtime channel opens');

        // 7. logout
        const out = await req('/logout', { method: 'POST', headers: { cookie } });
        t.equal(out.status, 303);
        t.ok(/Max-Age=0/.test(out.headers.get('set-cookie')), 'cookie cleared');
        t.equal((await req('/dashboard', { headers: { cookie } })).status, 302, 'after logout: dashboard -> login');
        t.equal((await req('/api/persona', { headers: { cookie } })).status, 401, 'after logout: old session rejected by the API');
        t.equal((await req('/lite')).status, 200, '/lite unaffected');
    } finally {
        server.kill();
    }
}

async function run() {
    unit();
    await endToEnd();
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('adminAuth tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

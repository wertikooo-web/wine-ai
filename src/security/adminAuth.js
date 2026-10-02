'use strict';

// Admin authentication for the beta: one shared admin account, server-side
// sessions, one route gate. See docs/ADMIN_AUTH.md for the route matrix.
//
// - Credentials only from the environment (ADMIN_USERNAME / ADMIN_PASSWORD);
//   nothing secret is committed.
// - Session = random 256-bit id in an HttpOnly, SameSite=Lax, Secure
//   (production) cookie, mapped server-side to {user, role, expiresAt}.
//   Logout deletes it server-side.
// - Failed logins are rate-limited per client IP.
// - Production (Railway) without ADMIN_PASSWORD fails closed: admin routes
//   are unavailable, public routes (/lite) keep working.

const crypto = require('crypto');

const COOKIE_NAME = 'wine_ai_admin';

function isProductionEnv(env = process.env) {
    return Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID)
        || String(env.NODE_ENV || '').toLowerCase() === 'production';
}

// ---- route classification (deny by default for /api/*) ----------------------

const ADMIN_PAGES = new Set(['/', '/dashboard', '/dashboard/', '/knowledge-studio', '/answer-audit', '/audit', '/avatar-lab', '/avatar-dev']);
const PUBLIC_EXACT = new Set([
    'GET /health',
    'GET /lite', 'GET /lite/',
    'GET /lite/access', 'GET /lite/access/',
    'GET /api/lite/access', 'POST /api/lite/access',
    'GET /api/lite/config',
    'GET /api/age-verification', 'POST /api/age-verification',
    'GET /api/companion/catalog',
    'GET /api/companion/wineries',
    'POST /api/analytics/link-event',
    'POST /api/live-test/feedback',
    'POST /api/analytics/session-end',
    'POST /api/analytics/purchase-click',
    'GET /login', 'POST /login', 'POST /logout',
]);

function classifyRoute(method, pathname) {
    const m = String(method || 'GET').toUpperCase();
    const p = String(pathname || '/');
    if (PUBLIC_EXACT.has(`${m} ${p}`)) return 'public';
    if (m === 'GET' && /^\/api\/companion\/wines\/cw_[A-Za-z0-9_-]{4,60}$/.test(p)) return 'public';
    if (p === '/api' || p.startsWith('/api/')) return 'admin';
    if (ADMIN_PAGES.has(p) || p.startsWith('/dashboard/')) return 'admin';
    if (p.startsWith('/visual-modules/debug/')) return 'admin';
    // Everything else is a static asset or an unknown path (404 downstream).
    return (m === 'GET' || m === 'HEAD') ? 'public' : 'admin';
}

// ---- helpers ------------------------------------------------------------------

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
    return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const key = part.slice(0, index).trim();
        if (key) out[key] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
}

// Rightmost X-Forwarded-For entry: the one appended by the platform proxy
// (Railway). Leftmost entries are client-controlled and would let an
// attacker dodge the login rate limit.
function clientIp(req) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
    return hops[hops.length - 1] || req.socket?.remoteAddress || 'unknown';
}

// Only same-origin admin paths are valid post-login destinations.
function safeNext(value) {
    const next = String(value || '');
    if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
    if (classifyRoute('GET', next.split('?')[0]) !== 'admin') return '/dashboard';
    return next.slice(0, 512);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- service --------------------------------------------------------------------

function createAdminAuth({ env = process.env, now = () => Date.now(), log = () => {} } = {}) {
    const username = String(env.ADMIN_USERNAME || 'admin');
    const password = String(env.ADMIN_PASSWORD || '');
    const token = String(env.ADMIN_TOKEN || '');
    const production = isProductionEnv(env);
    const ttlMs = Math.max(1, Number(env.ADMIN_SESSION_TTL_HOURS || 12)) * 60 * 60 * 1000;
    const maxFailures = Math.max(1, Number(env.ADMIN_LOGIN_MAX_FAILURES || 5));
    const failureWindowMs = Math.max(1000, Number(env.ADMIN_LOGIN_WINDOW_MS || 15 * 60 * 1000));

    // Auth is enforced whenever a password is configured, and always in
    // production (fail closed). Local dev/tests without a password keep the
    // previous open behavior.
    const enforced = Boolean(password) || production;
    const loginAvailable = Boolean(password);

    const sessions = new Map(); // id -> { user, role, expiresAt }
    const failures = new Map(); // ip -> { count, firstAt }

    function pruneSessions() {
        const t = now();
        for (const [id, s] of sessions) if (s.expiresAt <= t) sessions.delete(id);
    }

    function sessionFromRequest(req) {
        const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!id) return null;
        const session = sessions.get(id);
        if (!session) return null;
        if (session.expiresAt <= now()) {
            sessions.delete(id);
            return null;
        }
        return { id, ...session };
    }

    function tokenAuthenticated(req) {
        return Boolean(token) && safeEqual(req.headers['x-admin-token'] || '', token);
    }

    // true when the request may use admin routes.
    function isAdminRequest(req) {
        if (!enforced) return true;
        return Boolean(sessionFromRequest(req)) || tokenAuthenticated(req);
    }

    function cookie(value, maxAgeSeconds) {
        return [
            `${COOKIE_NAME}=${value}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
            production ? 'Secure' : null,
            `Max-Age=${maxAgeSeconds}`,
        ].filter(Boolean).join('; ');
    }

    function rateLimited(ip) {
        const entry = failures.get(ip);
        if (!entry) return 0;
        const elapsed = now() - entry.firstAt;
        if (elapsed > failureWindowMs) {
            failures.delete(ip);
            return 0;
        }
        return entry.count >= maxFailures ? Math.ceil((failureWindowMs - elapsed) / 1000) : 0;
    }

    function noteFailure(ip) {
        const entry = failures.get(ip);
        if (!entry || now() - entry.firstAt > failureWindowMs) failures.set(ip, { count: 1, firstAt: now() });
        else entry.count += 1;
        if (failures.size > 10000) failures.clear(); // bounded memory under abuse
    }

    // -> { ok, status, cookie?, retryAfter?, error? }
    function login(req, { username: u, password: p } = {}) {
        const ip = clientIp(req);
        const retryAfter = rateLimited(ip);
        if (retryAfter) {
            log('admin_login_rate_limited', { ip });
            return { ok: false, status: 429, retryAfter, error: 'too_many_attempts' };
        }
        if (!loginAvailable) return { ok: false, status: 503, error: 'admin_not_configured' };
        const good = safeEqual(u || '', username) & safeEqual(p || '', password);
        if (!good) {
            noteFailure(ip);
            log('admin_login_failed', { ip });
            return { ok: false, status: 401, error: 'invalid_credentials' };
        }
        failures.delete(ip);
        pruneSessions();
        const id = crypto.randomBytes(32).toString('base64url');
        sessions.set(id, { user: username, role: 'admin', expiresAt: now() + ttlMs });
        log('admin_login_ok', { ip });
        return { ok: true, status: 200, cookie: cookie(id, Math.floor(ttlMs / 1000)) };
    }

    function logout(req) {
        const session = sessionFromRequest(req);
        if (session) sessions.delete(session.id);
        return { cookie: cookie('', 0) };
    }

    return {
        enforced,
        loginAvailable,
        production,
        isAdminRequest,
        sessionFromRequest,
        login,
        logout,
        activeSessions: () => { pruneSessions(); return sessions.size; },
    };
}

function renderLoginPage({ next = '/dashboard', error = '', configured = true } = {}) {
    const message = !configured
        ? 'Вход администратора не настроен (ADMIN_PASSWORD). Публичный /lite работает.'
        : error === 'invalid_credentials' ? 'Неверный логин или пароль.'
            : error === 'too_many_attempts' ? 'Слишком много попыток. Попробуйте позже.'
                : '';
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>WINE AI · Вход</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; background: #f7f1e8; color: #2b1a1f; }
  @media (prefers-color-scheme: dark) { body { background: #1b1214; color: #f3e9e1; } form { background: #2a1d21 !important; } input { background: #1b1214; color: inherit; } }
  form { width: min(340px, calc(100vw - 32px)); background: #fff; padding: 28px 24px; border-radius: 16px; box-shadow: 0 16px 40px rgba(62,12,27,.15); }
  h1 { margin: 0 0 18px; font-size: 18px; letter-spacing: .12em; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9b8ae; border-radius: 10px; font: inherit; }
  button { margin-top: 18px; width: 100%; padding: 11px; border: 0; border-radius: 10px; background: #6b1e2b; color: #fdf6ec; font: 600 15px system-ui, sans-serif; cursor: pointer; }
  .err { margin-top: 12px; color: #b3261e; font-size: 13px; }
</style></head>
<body><form method="post" action="/login" autocomplete="on">
  <h1>WINE AI · ADMIN</h1>
  <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
  <label for="u">Логин</label><input id="u" name="username" autocomplete="username" required ${configured ? '' : 'disabled'}>
  <label for="p">Пароль</label><input id="p" name="password" type="password" autocomplete="current-password" required ${configured ? '' : 'disabled'}>
  <button type="submit" ${configured ? '' : 'disabled'}>Войти</button>
  ${message ? `<div class="err" role="alert">${escapeHtml(message)}</div>` : ''}
</form></body></html>`;
}

module.exports = { COOKIE_NAME, classifyRoute, createAdminAuth, renderLoginPage, safeNext, isProductionEnv, parseCookies };

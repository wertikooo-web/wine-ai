'use strict';

// Temporary guest access to Wine AI Lite (closed beta). See docs/LITE_ACCESS.md.
//
// - The operator creates access codes in the Dashboard (admin API only):
//   label (internal), code, expiry. Several codes live side by side; revoking
//   one never touches the others.
// - Codes are stored only as scrypt hashes (Node crypto, salted). The
//   plaintext is shown once, at creation, and never again.
// - A correct code opens a guest session: a signed value
//   {grant id, session expiry} carried in an HttpOnly SameSite=Lax cookie,
//   and -- for the partner-site iframe, where that cookie cannot travel -- as
//   a token the page keeps in sessionStorage (never the code itself).
// - Every check re-reads the grant (cached for a few seconds, invalidated on
//   revoke/delete), so expiry and revocation apply to sessions already open.
// - Failed attempts are rate-limited per client IP and logged without the
//   code. Wrong, expired and revoked codes get the same answer.
//
// Prepared for later (not implemented): max_uses / max_minutes per code, and
// per-code usage -- each guest session already knows its grant id.

const crypto = require('crypto');

const COOKIE_NAME = 'wine_ai_lite';
const HEADER_NAME = 'x-lite-access';
const QUERY_PARAM = 'la';
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_LIFETIME_MS = 31 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

// ---- helpers -------------------------------------------------------------------

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index < 1) continue;
        try { out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* skip */ }
    }
    return out;
}

// Rightmost X-Forwarded-For entry (appended by Railway's proxy); see adminAuth.
function clientIp(req) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
    return hops[hops.length - 1] || req.socket?.remoteAddress || 'unknown';
}

function scrypt(code, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(code), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
    });
}

async function hashCode(code) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(code, salt);
    return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyCodeHash(code, stored) {
    const [scheme, n, saltB64, keyB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || Number(n) !== SCRYPT.N || !saltB64 || !keyB64) return false;
    const expected = Buffer.from(keyB64, 'base64url');
    const actual = await scrypt(code, Buffer.from(saltB64, 'base64url'));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Codes are typed by people (often read out over the phone): case and spaces
// are ignored.
function normalizeCode(code) {
    return String(code || '').trim().replace(/\s+/g, '').toUpperCase();
}

// No 0/O/1/I/L: easy to dictate.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateCode(length = 8) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
}

function statusOf(row, now) {
    if (row.revoked_at) return 'REVOKED';
    if (new Date(row.expires_at).getTime() <= now) return 'EXPIRED';
    return 'ACTIVE';
}

// Signing key: an explicit LITE_ACCESS_SECRET, else derived from the admin
// credentials already in Railway (stable across deploys), else per-process
// (local dev: a restart signs everyone out).
function signingKey(env) {
    const base = env.LITE_ACCESS_SECRET || [env.ADMIN_PASSWORD, env.ADMIN_TOKEN].filter(Boolean).join('\u0000');
    if (!base) return crypto.randomBytes(32);
    return crypto.createHmac('sha256', 'wine-ai-lite-access/v1').update(base).digest();
}

// ---- stores ----------------------------------------------------------------------

async function applySchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS lite_access_codes (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            last_used_at TIMESTAMPTZ,
            use_count INTEGER NOT NULL DEFAULT 0,
            created_by TEXT,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS lite_access_codes_expires_idx ON lite_access_codes (expires_at);
    `);
}

const COLUMNS = 'id, label, code_hash, created_at, expires_at, revoked_at, last_used_at, use_count';

function createPostgresLiteAccessStore(poolProvider) {
    let ready = null;
    const pool = () => {
        const p = poolProvider();
        if (!p) throw Object.assign(new Error('lite_access_store_unavailable'), { code: 'lite_access_store_unavailable' });
        return p;
    };
    const init = () => {
        if (!ready) ready = applySchema(pool()).catch((error) => { ready = null; throw error; });
        return ready;
    };
    const q = async (sql, params) => { await init(); return (await pool().query(sql, params)).rows; };
    return {
        backend: 'postgres',
        init,
        async insert(row) {
            await q('INSERT INTO lite_access_codes (id, label, code_hash, expires_at, created_by) VALUES ($1, $2, $3, $4, $5)',
                [row.id, row.label, row.code_hash, row.expires_at, row.created_by || null]);
        },
        async list() { return q(`SELECT ${COLUMNS} FROM lite_access_codes ORDER BY created_at DESC LIMIT 500`); },
        async get(id) { return (await q(`SELECT ${COLUMNS} FROM lite_access_codes WHERE id = $1`, [id]))[0] || null; },
        async listUsable(nowIso) {
            return q(`SELECT ${COLUMNS} FROM lite_access_codes WHERE revoked_at IS NULL AND expires_at > $1 ORDER BY created_at DESC LIMIT 200`, [nowIso]);
        },
        async revoke(id, nowIso) {
            return (await q('UPDATE lite_access_codes SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1 RETURNING id', [id, nowIso])).length > 0;
        },
        async remove(id) { return (await q('DELETE FROM lite_access_codes WHERE id = $1 RETURNING id', [id])).length > 0; },
        async noteUse(id, nowIso) { await q('UPDATE lite_access_codes SET last_used_at = $2, use_count = use_count + 1 WHERE id = $1', [id, nowIso]); },
    };
}

function createMemoryLiteAccessStore() {
    const rows = new Map();
    const copy = (row) => (row ? { ...row } : null);
    return {
        backend: 'memory',
        async init() {},
        async insert(row) { rows.set(row.id, { created_at: new Date().toISOString(), revoked_at: null, last_used_at: null, use_count: 0, ...row }); },
        async list() { return [...rows.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(copy); },
        async get(id) { return copy(rows.get(id)); },
        async listUsable(nowIso) { return [...rows.values()].filter((r) => !r.revoked_at && new Date(r.expires_at) > new Date(nowIso)).map(copy); },
        async revoke(id, nowIso) { const r = rows.get(id); if (!r) return false; r.revoked_at = r.revoked_at || nowIso; return true; },
        async remove(id) { return rows.delete(id); },
        async noteUse(id, nowIso) { const r = rows.get(id); if (r) { r.last_used_at = nowIso; r.use_count += 1; } },
    };
}

// ---- service ---------------------------------------------------------------------

function createLiteAccess({ store, env = process.env, now = () => Date.now(), log = () => {}, production = false } = {}) {
    // Enforced in production unless explicitly switched off (emergency
    // rollback: LITE_ACCESS_ENFORCED=0 in Railway reopens /lite), and
    // anywhere with LITE_ACCESS_ENFORCED=1.
    const flag = String(env.LITE_ACCESS_ENFORCED || '').toLowerCase();
    const enforced = /^(1|true|yes|on)$/.test(flag) || (production && !/^(0|false|no|off)$/.test(flag));
    const key = signingKey(env);
    const maxFailures = Math.max(1, Number(env.LITE_ACCESS_MAX_FAILURES || 8));
    const failureWindowMs = Math.max(1000, Number(env.LITE_ACCESS_WINDOW_MS || 15 * 60 * 1000));
    const failures = new Map(); // ip -> { count, firstAt }
    const grantCache = new Map(); // id -> { row|null, at }

    const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

    function issueToken(grantId, expiresAtMs) {
        const payload = Buffer.from(JSON.stringify({ v: 1, g: grantId, e: expiresAtMs, n: crypto.randomBytes(6).toString('base64url') })).toString('base64url');
        return `${payload}.${sign(payload)}`;
    }

    function readToken(token) {
        if (typeof token !== 'string' || !token || token.length > 512) return null;
        const [payload, signature, ...extra] = token.split('.');
        if (!payload || !signature || extra.length) return null;
        const expected = sign(payload);
        if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
        try {
            const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            if (data.v !== 1 || typeof data.g !== 'string' || !Number.isFinite(data.e)) return null;
            return { grantId: data.g, expiresAt: data.e };
        } catch {
            return null;
        }
    }

    function cookie(value, maxAgeSeconds) {
        return [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', production ? 'Secure' : null, `Max-Age=${Math.max(0, maxAgeSeconds)}`]
            .filter(Boolean).join('; ');
    }

    async function grantRow(id) {
        const cached = grantCache.get(id);
        if (cached && now() - cached.at < CACHE_TTL_MS) return cached.row;
        const row = await store.get(id);
        grantCache.set(id, { row, at: now() });
        if (grantCache.size > 5000) grantCache.clear();
        return row;
    }

    // token -> { ok, grantId, expiresAt } | { ok: false, reason }
    async function checkToken(token) {
        const data = readToken(token);
        if (!data) return { ok: false, reason: 'lite_access_required' };
        const t = now();
        if (data.expiresAt <= t) return { ok: false, reason: 'lite_access_expired' };
        let row;
        try { row = await grantRow(data.grantId); } catch (error) {
            log('lite_access_store_error', { message: String(error?.message || error).slice(0, 120) });
            return { ok: false, reason: 'lite_access_unavailable' };
        }
        if (!row || statusOf(row, t) !== 'ACTIVE') return { ok: false, reason: 'lite_access_expired' };
        return { ok: true, grantId: data.grantId, expiresAt: Math.min(data.expiresAt, new Date(row.expires_at).getTime()) };
    }

    function tokenFromRequest(req) {
        const fromCookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (fromCookie) return fromCookie;
        const header = req.headers[HEADER_NAME];
        if (typeof header === 'string' && header) return header;
        try {
            const fromQuery = new URL(req.url || '/', 'http://localhost').searchParams.get(QUERY_PARAM);
            if (fromQuery) return fromQuery;
        } catch { /* no query */ }
        return null;
    }

    // Guest session on this request (cookie, header, or ?la= on the WebSocket).
    async function checkRequest(req) {
        if (!enforced) return { ok: true, grantId: null, expiresAt: null, open: true };
        return checkToken(tokenFromRequest(req));
    }

    function rateLimited(ip) {
        const entry = failures.get(ip);
        if (!entry) return 0;
        const elapsed = now() - entry.firstAt;
        if (elapsed > failureWindowMs) { failures.delete(ip); return 0; }
        return entry.count >= maxFailures ? Math.ceil((failureWindowMs - elapsed) / 1000) : 0;
    }

    function noteFailure(ip) {
        const entry = failures.get(ip);
        if (!entry || now() - entry.firstAt > failureWindowMs) failures.set(ip, { count: 1, firstAt: now() });
        else entry.count += 1;
        if (failures.size > 10000) failures.clear();
    }

    // Guest login. -> { ok, status, cookie?, token?, expiresAt?, retryAfter?, error? }
    async function login(req, code) {
        const ip = clientIp(req);
        const retryAfter = rateLimited(ip);
        if (retryAfter) {
            log('lite_access_rate_limited', { ip });
            return { ok: false, status: 429, retryAfter, error: 'too_many_attempts' };
        }
        const normalized = normalizeCode(code);
        let match = null;
        if (normalized.length >= 4 && normalized.length <= 64) {
            const nowIso = new Date(now()).toISOString();
            for (const row of await store.listUsable(nowIso)) {
                // eslint-disable-next-line no-await-in-loop -- a handful of active codes
                if (await verifyCodeHash(normalized, row.code_hash)) { match = row; break; }
            }
        }
        if (!match) {
            noteFailure(ip);
            log('lite_access_failed', { ip });
            return { ok: false, status: 401, error: 'invalid_code' };
        }
        failures.delete(ip);
        const expiresAt = Math.min(new Date(match.expires_at).getTime(), now() + MAX_SESSION_MS);
        const token = issueToken(match.id, expiresAt);
        await store.noteUse(match.id, new Date(now()).toISOString()).catch(() => {});
        log('lite_access_ok', { ip, grant: match.id });
        return { ok: true, status: 200, token, expiresAt, cookie: cookie(token, Math.floor((expiresAt - now()) / 1000)) };
    }

    function logoutCookie() { return cookie('', 0); }

    // ---- admin operations (called only from admin-gated routes) ----

    function publicRow(row) {
        const t = now();
        return {
            id: row.id,
            label: row.label,
            created_at: new Date(row.created_at).toISOString(),
            expires_at: new Date(row.expires_at).toISOString(),
            revoked_at: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
            last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
            use_count: Number(row.use_count) || 0,
            status: statusOf(row, t),
        };
    }

    async function createCode({ label, code, expiresAt, expiresInMinutes } = {}) {
        const errors = [];
        const cleanLabel = String(label || '').trim().slice(0, 80);
        if (!cleanLabel) errors.push('label_required');
        const plain = code ? normalizeCode(code) : generateCode();
        if (plain.length < 6 || plain.length > 64) errors.push('code_length_6_64');
        let expiresAtMs = NaN;
        if (expiresAt) expiresAtMs = new Date(expiresAt).getTime();
        else if (expiresInMinutes != null) expiresAtMs = now() + Number(expiresInMinutes) * 60 * 1000;
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now() + 30 * 1000) errors.push('expiry_in_future_required');
        else if (expiresAtMs > now() + MAX_LIFETIME_MS) errors.push('expiry_max_31_days');
        if (errors.length) return { ok: false, errors };
        // The same code twice would make login ambiguous.
        for (const row of await store.listUsable(new Date(now()).toISOString())) {
            // eslint-disable-next-line no-await-in-loop
            if (await verifyCodeHash(plain, row.code_hash)) return { ok: false, errors: ['code_already_active'] };
        }
        const row = {
            id: `lac_${crypto.randomBytes(9).toString('base64url')}`,
            label: cleanLabel,
            code_hash: await hashCode(plain),
            expires_at: new Date(expiresAtMs).toISOString(),
            created_by: 'admin',
        };
        await store.insert(row);
        log('lite_access_code_created', { grant: row.id, expires_at: row.expires_at });
        const saved = await store.get(row.id);
        return { ok: true, code: plain, entry: publicRow(saved || { ...row, created_at: new Date(now()).toISOString(), use_count: 0 }) };
    }

    async function listCodes() { return (await store.list()).map(publicRow); }

    async function revokeCode(id) {
        const ok = await store.revoke(String(id || ''), new Date(now()).toISOString());
        grantCache.delete(String(id || ''));
        if (ok) log('lite_access_code_revoked', { grant: id });
        return ok;
    }

    async function deleteCode(id) {
        const ok = await store.remove(String(id || ''));
        grantCache.delete(String(id || ''));
        if (ok) log('lite_access_code_deleted', { grant: id });
        return ok;
    }

    // Still valid? (open WebSocket sessions poll this; cached briefly).
    async function isGrantActive(grantId, sessionExpiresAt) {
        if (!enforced || !grantId) return true;
        if (Number.isFinite(sessionExpiresAt) && sessionExpiresAt <= now()) return false;
        try {
            const row = await grantRow(grantId);
            return Boolean(row) && statusOf(row, now()) === 'ACTIVE';
        } catch {
            return true; // store hiccup: never cut a live conversation on a DB blip
        }
    }

    return {
        enforced,
        checkRequest,
        checkToken,
        login,
        logoutCookie,
        createCode,
        listCodes,
        revokeCode,
        deleteCode,
        isGrantActive,
        init: () => store.init(),
    };
}

// Access screen (/lite/access): the /lite page sends the visitor here while
// there is no guest session. Minimal, no app code; RU/RO/EN.
function renderAccessPage() {
    return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>WINE AI</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f1e8; --card: #fff; --ink: #2b1a1f; --muted: #7a6468; --accent: #6b1e2b; --line: #d9c9be; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1214; --card: #2a1d21; --ink: #f3e9e1; --muted: #b9a5a6; --line: #4a3a3e; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: 16px; font: 16px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; background: var(--bg); color: var(--ink); }
  form { width: min(360px, 100%); background: var(--card); padding: 30px 24px 26px; border-radius: 18px; box-shadow: 0 18px 44px rgba(62,12,27,.16); text-align: center; }
  h1 { margin: 0 0 6px; font-size: 22px; letter-spacing: .16em; color: var(--accent); }
  @media (prefers-color-scheme: dark) { h1 { color: #e8b4bd; } }
  p { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
  input { width: 100%; padding: 13px 14px; border: 1px solid var(--line); border-radius: 12px; font: 600 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-align: center; text-transform: uppercase; background: transparent; color: inherit; }
  button { margin-top: 14px; width: 100%; padding: 13px; border: 0; border-radius: 12px; background: var(--accent); color: #fdf6ec; font: 600 16px system-ui, sans-serif; cursor: pointer; }
  button[disabled] { opacity: .6; cursor: default; }
  .msg { min-height: 20px; margin-top: 12px; font-size: 14px; color: #b3261e; }
  @media (prefers-color-scheme: dark) { .msg { color: #ffb4ab; } }
</style></head>
<body><form id="f" autocomplete="off" novalidate>
  <h1>WINE AI</h1>
  <p id="t"></p>
  <input id="c" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="64" required aria-label="code">
  <button id="b" type="submit"></button>
  <div class="msg" id="m" role="alert"></div>
</form>
<script>
(() => {
  const L = {
    ru: { t: 'Введите код доступа', b: 'Войти', bad: 'Неверный или недействительный код доступа.', many: 'Слишком много попыток. Попробуйте позже.', exp: 'Срок тестового доступа закончился.', err: 'Нет связи с сервером. Попробуйте ещё раз.' },
    ro: { t: 'Introduceți codul de acces', b: 'Intră', bad: 'Cod de acces greșit sau nevalid.', many: 'Prea multe încercări. Încercați mai târziu.', exp: 'Accesul de test a expirat.', err: 'Nu există conexiune cu serverul. Încercați din nou.' },
    en: { t: 'Enter access code', b: 'Enter', bad: 'Invalid or expired access code.', many: 'Too many attempts. Please try again later.', exp: 'Your test access has expired.', err: 'Cannot reach the server. Please try again.' },
  };
  const params = new URLSearchParams(location.search);
  const want = (params.get('lang') || navigator.language || 'ru').slice(0, 2).toLowerCase();
  const s = L[want] || (want === 'mo' ? L.ro : L.en);
  document.documentElement.lang = L[want] ? want : 'en';
  const $ = (id) => document.getElementById(id);
  $('t').textContent = s.t; $('b').textContent = s.b;
  let expired = false;
  try { expired = sessionStorage.getItem('wineAiLiteExpired') === '1'; sessionStorage.removeItem('wineAiLiteExpired'); } catch {}
  if (expired || params.get('expired') === '1') $('m').textContent = s.exp;
  $('c').focus();
  $('f').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('c').value.trim();
    if (!code) return;
    $('b').disabled = true; $('m').textContent = '';
    try {
      const r = await fetch('/api/lite/access', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && d.token) {
        try { sessionStorage.setItem('wineAiLiteAccess', d.token); } catch {}
        params.delete('expired');
        const q = params.toString();
        location.replace('/lite' + (q ? '?' + q : ''));
        return;
      }
      $('m').textContent = r.status === 429 ? s.many : s.bad;
    } catch { $('m').textContent = s.err; }
    $('b').disabled = false; $('c').select();
  });
})();
</script></body></html>`;
}

module.exports = {
    COOKIE_NAME,
    HEADER_NAME,
    QUERY_PARAM,
    createLiteAccess,
    createPostgresLiteAccessStore,
    createMemoryLiteAccessStore,
    renderAccessPage,
    generateCode,
    normalizeCode,
    hashCode,
    verifyCodeHash,
};

'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'wine_ai_adult';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
// An explicitly configured secret survives deploys. The process-local fallback
// is deliberate for local development: a restart invalidates every session.
const signingSecret = process.env.AGE_VERIFICATION_SECRET || crypto.randomBytes(32).toString('hex');

function sign(value) {
    return crypto.createHmac('sha256', signingSecret).update(value).digest('base64url');
}

function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map((part) => {
        const index = part.indexOf('=');
        if (index < 1) return null;
        try {
            return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
        } catch {
            return null;
        }
    }).filter(Boolean));
}

// The same signed value as the cookie. Used where a cookie cannot travel:
// Wine AI Lite embedded as an iframe on a partner site (cross-site iframe,
// SameSite=Lax cookie is not sent; Safari blocks third-party cookies).
function issueAdultToken({ now = Date.now() } = {}) {
    const payload = Buffer.from(JSON.stringify({ v: 1, verifiedAt: now, expiresAt: now + MAX_AGE_MS })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

function isAdultTokenValid(token, options) {
    if (typeof token !== 'string' || !token || token.length > 512) return false;
    return isAdultVerified(`${COOKIE_NAME}=${encodeURIComponent(token)}`, options);
}

function issueAdultCookie({ now = Date.now(), secure = false, token } = {}) {
    const value = token || issueAdultToken({ now });
    return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(MAX_AGE_MS / 1000)}${secure ? '; Secure' : ''}`;
}

function isAdultVerified(cookieHeader, { now = Date.now() } = {}) {
    const raw = parseCookies(cookieHeader)[COOKIE_NAME];
    if (!raw) return false;
    const [payload, signature, ...extra] = raw.split('.');
    const expectedSignature = sign(payload);
    if (!payload || !signature || extra.length || signature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return false;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.v === 1 && Number.isFinite(data.verifiedAt) && Number.isFinite(data.expiresAt)
            && data.verifiedAt <= now && data.expiresAt > now && data.expiresAt - data.verifiedAt <= MAX_AGE_MS;
    } catch {
        return false;
    }
}

module.exports = { COOKIE_NAME, MAX_AGE_MS, issueAdultCookie, issueAdultToken, isAdultTokenValid, isAdultVerified, parseCookies };

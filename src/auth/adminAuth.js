'use strict';

const crypto = require('crypto');
const { parseCookies, setCookie, clearCookie } = require('./cookieHelper');

const COOKIE_NAME = 'wa_session';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_TOKEN_SEPARATOR = '|';

function createAdminAuth({
    password = '',
    token = '',
    sessionTtlMs = 24 * 60 * 60 * 1000,
    cookieSecret = '',
} = {}) {
    if (!password && !token) {
        throw new Error('adminAuth requires either password or token');
    }

    const sessions = new Map(); // sessionId → { expiresAt }

    function gc() {
        const now = Date.now();
        for (const [id, entry] of sessions) {
            if (entry.expiresAt <= now) sessions.delete(id);
        }
    }

    function createSession() {
        gc();
        const sessionId = crypto.randomBytes(24).toString('hex');
        sessions.set(sessionId, { expiresAt: Date.now() + sessionTtlMs });
        return sessionId;
    }

    function destroySession(sessionId) {
        sessions.delete(sessionId);
    }

    function isValidSession(sessionId) {
        if (!sessionId) return false;
        const entry = sessions.get(sessionId);
        if (!entry) return false;
        if (entry.expiresAt <= Date.now()) {
            sessions.delete(sessionId);
            return false;
        }
        return true;
    }

    function verifyCredentials(providedPassword) {
        if (password && providedPassword === password) return true;
        if (token && providedPassword === token) return true;
        return false;
    }

    function signPayload(payload) {
        if (!cookieSecret) return payload;
        const hmac = crypto.createHmac('sha256', cookieSecret);
        hmac.update(payload);
        return `${payload}${CSRF_TOKEN_SEPARATOR}${hmac.digest('hex')}`;
    }

    function verifyPayload(signed) {
        if (!cookieSecret) return true;
        const sepIndex = signed.lastIndexOf(CSRF_TOKEN_SEPARATOR);
        if (sepIndex === -1) return false;
        const payload = signed.slice(0, sepIndex);
        const signature = signed.slice(sepIndex + 1);
        const hmac = crypto.createHmac('sha256', cookieSecret);
        hmac.update(payload);
        const expected = hmac.digest('hex');
        if (signature.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    }

    function generateCsrfToken(sessionId) {
        const payload = `${sessionId}:${Date.now()}`;
        return signPayload(payload);
    }

    function verifyCsrfToken(sessionId, csrfToken) {
        if (!sessionId || !csrfToken) return false;
        if (!verifyPayload(csrfToken)) return false;
        const sepIndex = csrfToken.lastIndexOf(CSRF_TOKEN_SEPARATOR);
        const payload = sepIndex === -1 ? csrfToken : csrfToken.slice(0, sepIndex);
        const parts = payload.split(':');
        if (parts.length !== 2) return false;
        if (parts[0] !== sessionId) return false;
        const ts = Number(parts[1]);
        if (!Number.isFinite(ts)) return false;
        const age = Date.now() - ts;
        if (age < 0 || age > sessionTtlMs) return false;
        return true;
    }

    function extractSessionId(req) {
        const cookies = parseCookies(req);
        return cookies.get(COOKIE_NAME) || null;
    }

    function requireAuth(req, res) {
        const sessionId = extractSessionId(req);
        if (!isValidSession(sessionId)) {
            if (res && !res.headersSent) {
                res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
            }
            return null;
        }
        return sessionId;
    }

    function requireCsrf(req, res, sessionId) {
        const csrfToken = req.headers[CSRF_HEADER] || '';
        if (!verifyCsrfToken(sessionId, csrfToken)) {
            if (res && !res.headersSent) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: 'csrf_invalid' }));
            }
            return false;
        }
        return true;
    }

    function setSessionCookie(res, sessionId) {
        setCookie(res, COOKIE_NAME, sessionId, {
            maxAge: Math.floor(sessionTtlMs / 1000),
            path: '/',
            httpOnly: true,
            sameSite: 'Strict',
            secure: process.env.NODE_ENV === 'production',
        });
    }

    function clearSessionCookie(res) {
        clearCookie(res, COOKIE_NAME, { path: '/' });
    }

    return {
        createSession,
        destroySession,
        isValidSession,
        verifyCredentials,
        generateCsrfToken,
        verifyCsrfToken,
        extractSessionId,
        requireAuth,
        requireCsrf,
        setSessionCookie,
        clearSessionCookie,
    };
}

module.exports = { createAdminAuth, COOKIE_NAME };

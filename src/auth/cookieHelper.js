'use strict';

function parseCookies(req) {
    const header = req.headers.cookie || '';
    const cookies = new Map();
    for (const pair of header.split(';')) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const name = trimmed.slice(0, eqIndex).trim();
        const value = decodeURIComponent(trimmed.slice(eqIndex + 1).trim());
        if (name) cookies.set(name, value);
    }
    return cookies;
}

function setCookie(res, name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    if (opts.secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name, opts = {}) {
    setCookie(res, name, '', { ...opts, maxAge: 0 });
}

module.exports = { parseCookies, setCookie, clearCookie };

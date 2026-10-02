'use strict';

// Browser diagnostics open /lite like a guest: a temporary access code is
// created through the admin API, exchanged for a guest session cookie, set on
// the production origin only (never the admin token in browser headers -- it
// would reach third-party hosts), and deleted afterwards.
//
//   const guest = await grantLiteGuest({ baseUrl, adminToken });
//   if (guest) await page.setCookie(guest.cookie);
//   ... finally: await guest?.cleanup();

async function grantLiteGuest({ baseUrl, adminToken, label = 'diagnostic', minutes = 30 } = {}) {
    if (!adminToken) return null;
    const headers = { 'x-admin-token': adminToken, 'content-type': 'application/json' };
    const created = await fetch(`${baseUrl}/api/lite-access/codes`, { method: 'POST', headers, body: JSON.stringify({ label: `diag: ${label}`, expires_in_minutes: minutes }) })
        .then((r) => r.json()).catch(() => null);
    if (!created || !created.ok) return null; // server without guest access (older build): /lite is open
    const cleanup = () => fetch(`${baseUrl}/api/lite-access/codes/${created.entry.id}`, { method: 'DELETE', headers }).catch(() => {});
    const login = await fetch(`${baseUrl}/api/lite/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: created.code }) });
    const setCookie = login.headers.get('set-cookie') || '';
    const [pair] = setCookie.split(';');
    const index = pair.indexOf('=');
    if (!login.ok || index < 1) { await cleanup(); return null; }
    return {
        cookie: { name: pair.slice(0, index), value: decodeURIComponent(pair.slice(index + 1)), url: baseUrl, httpOnly: true },
        cleanup,
    };
}

module.exports = { grantLiteGuest };

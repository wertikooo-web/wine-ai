'use strict';

// Imports data/demo-links/winemd-wines.json (wine.md product pages: name,
// image, price, wine.md link; winery official site from Ghidul vinului)
// into the production Visual Companion catalog through the admin API.
// Records are validated again server-side; unpublish with
// POST /api/companion/wines/:id/published {published:false}.
//
//   BASE_URL=... ADMIN_TOKEN=... node scripts/import-companion-wines.js

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const FILE = process.env.WINES_FILE || path.join(__dirname, '..', 'data', 'demo-links', 'winemd-wines.json');

async function main() {
    if (!process.env.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is required');
    const wines = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    let imported = 0;
    const rejected = [];
    for (let i = 0; i < wines.length; i += 150) {
        const batch = wines.slice(i, i + 150);
        const res = await fetch(`${BASE_URL}/api/companion/wines/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN },
            body: JSON.stringify({ wines: batch, published: true, source: 'winemd-2026-09-30' }),
        });
        const body = await res.json().catch(() => ({}));
        imported += Array.isArray(body.imported) ? body.imported.length : 0;
        // A host allowlist (COMPANION_URL_HOSTS) may reject the winery's own
        // site: keep the wine card with its wine.md link, without that CTA.
        const retry = (body.rejected || []).filter((r) => r.errors.length === 1 && r.errors[0] === 'wineryUrl_unsafe').map((r) => { const { wineryUrl, ...rest } = batch[r.index]; return rest; });
        if (retry.length) {
            const res2 = await fetch(`${BASE_URL}/api/companion/wines/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN }, body: JSON.stringify({ wines: retry, published: true, source: 'winemd-2026-09-30' }) });
            const body2 = await res2.json().catch(() => ({}));
            imported += Array.isArray(body2.imported) ? body2.imported.length : 0;
            console.log(`   retried ${retry.length} without wineryUrl: imported=${(body2.imported || []).length}`);
        }
        for (const r of body.rejected || []) if (!(r.errors.length === 1 && r.errors[0] === 'wineryUrl_unsafe')) rejected.push({ wine: batch[r.index] && batch[r.index].wineName, errors: r.errors });
        console.log(`batch ${i / 150 + 1}: http=${res.status} imported=${(body.imported || []).length} rejected=${(body.rejected || []).length}`);
    }
    console.log(`imported ${imported}/${wines.length}; rejected ${rejected.length}`);
    for (const r of rejected.slice(0, 20)) console.log(`   rejected ${r.wine}: ${r.errors.join(',')}`);
    const catalog = await fetch(`${BASE_URL}/api/companion/catalog`).then((r) => r.json()).catch(() => null);
    console.log(`public catalog now: ${catalog && Array.isArray(catalog.wines) ? catalog.wines.length : 'unavailable'} wines`);
    if (!imported) process.exit(1);
}

main().catch((error) => { console.error(error.message); process.exit(1); });

'use strict';

// Production diagnostic (read-only): which verified links WINE AI actually
// has today. Two existing sources:
//   1. Visual Companion wine catalog (/api/companion/wines): productUrl,
//      wineryUrl, mapUrl per wine -- the only source of on-screen wine CTAs.
//   2. Knowledge Studio entity facts (/api/studio/entities[/:id]): website,
//      booking_url, purchase_url, coordinates/latitude/longitude, address
//      per registry entity, with source and validation status.
// Prints counts and real sample links (never invents any).

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const LINK_FIELDS = ['website', 'booking_url', 'purchase_url', 'coordinates', 'latitude', 'longitude', 'address', 'maps_url', 'official_url', 'product_url'];

async function get(p) {
    const res = await fetch(`${BASE_URL}${p}`, { headers: process.env.ADMIN_TOKEN ? { 'x-admin-token': process.env.ADMIN_TOKEN } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
    const catalog = await get('/api/companion/catalog');
    const wines = await get('/api/companion/wines');
    console.log(`== Companion catalog: public /api/companion/catalog http=${catalog.status} entries=${Array.isArray(catalog.json?.wines) ? catalog.json.wines.length : JSON.stringify(catalog.json).slice(0, 200)}`);
    if (Array.isArray(wines.json?.wines)) {
        const list = wines.json.wines;
        const pub = list.filter((w) => w.published);
        const has = (k) => pub.filter((w) => w[k]).length;
        console.log(`   storage=${wines.json.storage} total=${list.length} published=${pub.length} productUrl=${has('productUrl')} wineryUrl=${has('wineryUrl')} mapUrl=${has('mapUrl')}`);
        for (const w of pub.slice(0, 8)) console.log(`   wine="${w.wineName}" winery="${w.wineryName}" product=${w.productUrl || '-'} winery=${w.wineryUrl || '-'} map=${w.mapUrl || '-'}`);
    } else {
        console.log(`   /api/companion/wines http=${wines.status} ${JSON.stringify(wines.json).slice(0, 200)}`);
    }

    const entities = await get('/api/studio/entities?q=');
    const list = Array.isArray(entities.json?.entities) ? entities.json.entities : [];
    console.log(`\n== Knowledge registry entities http=${entities.status} total=${list.length}`);
    const byType = {};
    for (const e of list) byType[e.entityType || 'unknown'] = (byType[e.entityType || 'unknown'] || 0) + 1;
    console.log(`   by type: ${JSON.stringify(byType)}`);
    const withFacts = list.filter((e) => e.factCount > 0);
    console.log(`   entities with any fact: ${withFacts.length} (live approved/validated: ${list.filter((e) => e.liveFactCount > 0).length})`);

    const coverage = {}; // type -> field -> {any, live}
    const samples = [];
    for (const e of withFacts) {
        const card = await get(`/api/studio/entities/${encodeURIComponent(e.entityId)}`);
        const facts = card.json?.card?.facts || [];
        const type = e.entityType || 'unknown';
        coverage[type] = coverage[type] || {};
        const seen = new Set();
        for (const f of facts) {
            if (!LINK_FIELDS.includes(f.field_name) || seen.has(f.field_name)) continue;
            seen.add(f.field_name);
            const live = f.active && ['approved', 'validated'].includes(f.validation_status);
            const c = coverage[type][f.field_name] = coverage[type][f.field_name] || { any: 0, live: 0 };
            c.any += 1;
            if (live) c.live += 1;
            if (/url|website/.test(f.field_name) && samples.length < 12) samples.push(`${type} "${e.canonicalName}" ${f.field_name}=${f.normalized_value || f.raw_value} status=${f.validation_status} active=${f.active} source=${f.source_type || '-'}`);
        }
    }
    const typeTotals = byType;
    console.log('\n== Link fact coverage (entities with the field: any / approved+active, out of registry total per type)');
    for (const [type, fields] of Object.entries(coverage)) {
        console.log(`   ${type} (registry ${typeTotals[type] || 0}): ${Object.entries(fields).map(([k, v]) => `${k}=${v.any}/${v.live}`).join(' ')}`);
    }
    console.log('\n== Sample real links from entity facts');
    for (const s of samples) console.log(`   ${s}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

'use strict';

// Crawl (read-only, GitHub runner) of wine.md's own product pages, so the
// Visual Companion can show real wine cards with real wine.md links.
//
//   WINEMD_DISCOVER=1  -> print the raw structure of one brand page and one
//                         product page (to see what can be parsed).
//   default            -> for every brand page listed in
//                         data/demo-links/wineries.json-adjacent brand list,
//                         collect product links, read each product page's
//                         schema.org JSON-LD (name, image, price, brand) and
//                         write /tmp/winemd-wines/wines.json.
// Nothing is invented: every field comes from wine.md's own markup; a
// product without a name in its markup is skipped.

const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.WINEMD_OUT || '/tmp/winemd-wines';
const UA = 'Mozilla/5.0 (compatible; WineAI-link-check/1.0)';
const BASE = 'https://wine.md';

async function get(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'text/html' } });
        return { status: res.status, url: res.url, html: await res.text() };
    } catch (error) {
        return { status: 0, url, html: '', error: String(error && (error.cause && error.cause.code || error.message)).slice(0, 80) };
    } finally {
        clearTimeout(timer);
    }
}

function productLinks(html, pageUrl) {
    const out = new Map();
    for (const m of html.matchAll(/href\s*=\s*["']([^"'#?]*\/catalog\/wine\/[^"'#?]+)["']/gi)) {
        let href;
        try { href = new URL(m[1], pageUrl).href; } catch { continue; }
        if (!/^https:\/\/wine\.md\//.test(href)) continue;
        href = href.replace(/^https:\/\/wine\.md\/(ro|en)\//, 'https://wine.md/ru/').replace(/^https:\/\/wine\.md\/catalog\//, 'https://wine.md/ru/catalog/');
        if (href.split('/').length < 8) continue; // category pages, not products
        out.set(href, true);
    }
    return [...out.keys()];
}

function jsonLd(html) {
    const blocks = [];
    for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try { blocks.push(JSON.parse(m[1].trim())); } catch { /* skip */ }
    }
    const flat = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { flat.push(v); if (v['@graph']) walk(v['@graph']); } };
    walk(blocks);
    return flat;
}

function meta(html, prop) {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return m ? m[1] : null;
}

async function discover(brandSlug) {
    const brand = await get(`${BASE}/ru/brand/${brandSlug}`);
    console.log(`brand ${brandSlug}: http=${brand.status} url=${brand.url} bytes=${brand.html.length}`);
    const links = productLinks(brand.html, brand.url);
    console.log(`product links: ${links.length}`);
    links.slice(0, 8).forEach((l) => console.log(`   ${l}`));
    const pages = [...new Set([...brand.html.matchAll(/href=["']([^"']*[?&]page=\d+[^"']*)["']/gi)].map((m) => m[1]))];
    console.log(`pagination hrefs: ${pages.slice(0, 5).join(' ')}`);
    if (!links[0]) return;
    const product = await get(links[0]);
    console.log(`\nproduct ${links[0]}: http=${product.status} bytes=${product.html.length}`);
    for (const node of jsonLd(product.html)) console.log(`   ld+json ${node['@type']}: ${JSON.stringify(node).slice(0, 700)}`);
    for (const p of ['og:title', 'og:image', 'og:description', 'product:price:amount', 'product:price:currency']) console.log(`   meta ${p}: ${meta(product.html, p)}`);
    const title = product.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    console.log(`   h1: ${title ? title[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null}`);
}

function productFromPage(url, html, brandSlug) {
    const nodes = jsonLd(html);
    const p = nodes.find((n) => /Product/i.test(String(n['@type'])));
    const name = (p && p.name) || meta(html, 'og:title') || null;
    if (!name) return null;
    const offer = p && (Array.isArray(p.offers) ? p.offers[0] : p.offers);
    const image = (p && (Array.isArray(p.image) ? p.image[0] : (p.image && p.image.url) || p.image)) || meta(html, 'og:image');
    return {
        productUrl: url,
        name: String(name).replace(/\s+/g, ' ').trim(),
        brandSlug,
        brand: p && p.brand ? (p.brand.name || p.brand) : null,
        imageUrl: typeof image === 'string' ? image : null,
        price: offer && offer.price ? Number(offer.price) : null,
        currency: offer && offer.priceCurrency ? String(offer.priceCurrency) : null,
        category: (url.match(/\/catalog\/wine\/([^/]+)/) || [])[1] || null,
        description: p && p.description ? String(p.description).replace(/\s+/g, ' ').trim().slice(0, 500) : null,
    };
}

async function crawl() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const brands = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'demo-links', 'wineries.json'), 'utf8'))
        .map((r) => (typeof r.wine_md_brand === 'string' ? r.wine_md_brand.split('/').pop() : null)).filter(Boolean);
    const productToBrand = new Map();
    for (const slug of brands) {
        for (let page = 1; page <= 5; page += 1) {
            const r = await get(`${BASE}/ru/brand/${slug}${page > 1 ? `?page=${page}` : ''}`);
            const links = productLinks(r.html, r.url || BASE);
            const fresh = links.filter((l) => !productToBrand.has(l));
            fresh.forEach((l) => productToBrand.set(l, slug));
            if (!fresh.length) break;
        }
        console.log(`brand ${slug}: ${[...productToBrand.values()].filter((s) => s === slug).length} products`);
    }
    const urls = [...productToBrand.keys()];
    console.log(`\nproducts to read: ${urls.length}`);
    const wines = [];
    for (let i = 0; i < urls.length; i += 6) {
        const batch = await Promise.all(urls.slice(i, i + 6).map(async (u) => {
            const r = await get(u);
            return r.status === 200 ? productFromPage(r.url || u, r.html, productToBrand.get(u)) : null;
        }));
        wines.push(...batch.filter(Boolean));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'wines.json'), JSON.stringify(wines, null, 1));
    console.log(`wines parsed: ${wines.length}; with image ${wines.filter((w) => w.imageUrl).length}; with price ${wines.filter((w) => w.price).length}`);
    // One line per wine so the result can be reviewed from the job log.
    for (const w of wines) console.log(`WINE\t${JSON.stringify(w)}`);
}

(process.env.WINEMD_DISCOVER ? discover(process.env.WINEMD_DISCOVER_BRAND || 'chateau-purcari') : crawl())
    .catch((error) => { console.error(error); process.exit(1); });

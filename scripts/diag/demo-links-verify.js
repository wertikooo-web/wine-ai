'use strict';

// Diagnostic (read-only, runs on a GitHub runner with open internet):
//   1. every official winery website taken from the Ghidul vinului book
//      (data/demo-links/ghid-websites.json) -- does it answer, where does it
//      redirect;
//   2. wine.md seed pages -- which winery / excursion / wine links exist
//      there, copied exactly as the site links them.
// Prints results and writes /tmp/demo-links/report.json. Never invents URLs.

const fs = require('fs');
const path = require('path');

const OUT_DIR = process.env.DEMO_LINKS_OUT || '/tmp/demo-links';
const UA = 'Mozilla/5.0 (compatible; WineAI-link-check/1.0)';
const WINE_MD_SEEDS = String(process.env.WINE_MD_SEEDS || 'https://wine.md/,https://wine.md/excursions,https://wine.md/ro/,https://wine.md/ru/,https://wine.md/en/')
    .split(',').map((s) => s.trim()).filter(Boolean);

async function fetchPage(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': UA, accept: 'text/html,*/*' } });
        const body = await res.text().catch(() => '');
        return { url, status: res.status, finalUrl: res.url, ms: Date.now() - startedAt, body };
    } catch (error) {
        return { url, status: 0, finalUrl: null, ms: Date.now() - startedAt, error: String(error && (error.cause && error.cause.code || error.message) || error).slice(0, 80), body: '' };
    } finally {
        clearTimeout(timer);
    }
}

function anchors(html, baseUrl) {
    const out = [];
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let href;
        try { href = new URL(m[1], baseUrl).href; } catch { continue; }
        const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        out.push({ href, text });
    }
    return out;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const sites = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'demo-links', 'ghid-websites.json'), 'utf8'));

    console.log(`== Official websites from the Ghid (${sites.length})`);
    const siteResults = [];
    for (let i = 0; i < sites.length; i += 6) {
        const batch = await Promise.all(sites.slice(i, i + 6).map(async (s) => {
            let r = await fetchPage(s.website);
            if (r.status === 0 || r.status >= 400) {
                const bare = s.website.replace('://www.', '://');
                if (bare !== s.website) {
                    const r2 = await fetchPage(bare);
                    if (r2.status && r2.status < 400) r = r2;
                }
            }
            const title = (r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
            // The winery's own site links its social pages: those are the
            // verified accounts (first profile link of each network).
            const social = (host) => {
                for (const a of anchors(r.body || '', r.finalUrl || s.website)) {
                    let u; try { u = new URL(a.href); } catch { continue; }
                    if (!u.hostname.replace(/^www\.|^m\./, '').startsWith(host)) continue;
                    const path = u.pathname.replace(/\/+$/, '');
                    if (!path || /^\/(sharer|share|intent|dialog|plugins|tr|p|reel|watch|hashtag|explore)(\/|$|\.php)/i.test(path)) continue;
                    return `https://www.${host}${path}`;
                }
                return null;
            };
            return { winery: s.winery, website: s.website, status: r.status, finalUrl: r.finalUrl, ms: r.ms, error: r.error || null, title: title ? title.replace(/\s+/g, ' ').trim().slice(0, 70) : null, instagram: social('instagram.com'), facebook: social('facebook.com') };
        }));
        siteResults.push(...batch);
    }
    for (const r of siteResults) {
        const ok = r.status >= 200 && r.status < 400;
        console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${r.winery} | ${r.website} -> ${r.status || r.error} ${r.finalUrl && r.finalUrl !== r.website + '/' ? r.finalUrl : ''} | ${r.title || ''}`);
        if (r.instagram || r.facebook) console.log(`SOCIAL\t${JSON.stringify({ winery: r.winery, instagram: r.instagram, facebook: r.facebook })}`);
    }
    console.log(`   alive: ${siteResults.filter((r) => r.status >= 200 && r.status < 400).length}/${siteResults.length}`);

    console.log('\n== wine.md seed pages');
    const wineMd = {};
    for (const seed of WINE_MD_SEEDS) {
        const r = await fetchPage(seed);
        const links = r.body ? anchors(r.body, r.finalUrl || seed).filter((a) => /(^|\.)wine\.md$/i.test(new URL(a.href).hostname)) : [];
        const unique = [...new Map(links.map((a) => [a.href, a])).values()];
        wineMd[seed] = { status: r.status, finalUrl: r.finalUrl, error: r.error || null, links: unique };
        console.log(`\n-- ${seed} -> ${r.status || r.error} ${r.finalUrl || ''} links=${unique.length}`);
        for (const a of unique) console.log(`   ${a.href} | ${a.text}`);
    }

    // Wine images as imported (wine.md root /assets) vs. as published (/ru//assets).
    const winesFile = path.join(__dirname, '..', '..', 'data', 'demo-links', 'winemd-wines.json');
    if (fs.existsSync(winesFile)) {
        const sample = JSON.parse(fs.readFileSync(winesFile, 'utf8')).filter((w) => w.imageUrl).slice(0, 6);
        console.log('\n== wine image URLs');
        for (const w of sample) {
            for (const u of [w.imageUrl, w.imageUrl.replace('https://wine.md/assets/', 'https://wine.md/ru//assets/')]) {
                const res = await fetch(u, { method: 'GET', headers: { 'user-agent': UA } }).catch((e) => ({ status: 0, headers: new Map(), e }));
                console.log(`   ${res.status} ${res.headers && res.headers.get ? res.headers.get('content-type') : ''} ${u}`);
            }
        }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ sites: siteResults, wineMd }, null, 1));
}

main().catch((error) => { console.error(error); process.exit(1); });

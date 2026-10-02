'use strict';

// Production end-to-end proof of verified links on /lite (real Chrome):
//   1. wait until production serves /api/companion/wineries (new build);
//   2. open /lite, start a session, type a question naming a winery;
//   3. read the cards rendered under the answer (winery + wine cards, their
//      buttons and URLs) and click the first button;
//   4. read /api/analytics/links (admin) and show that the render and the
//      click were recorded.
//
//   BASE_URL=... ADMIN_TOKEN=... CHROME=... node scripts/diag/links-e2e.js

const puppeteer = require('puppeteer-core');
const { grantLiteGuest } = require('./liteGuestAccess');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const QUESTION = process.env.LINKS_QUESTION || 'Расскажи коротко про винодельню Пуркарь и её вино Negru de Purcari. Можно ли туда съездить на экскурсию?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function analytics() {
    const res = await fetch(`${BASE_URL}/api/analytics/links?days=1`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '' } });
    return res.ok ? res.json() : { http: res.status };
}

async function main() {
    for (let i = 0; i < 40; i += 1) {
        const r = await fetch(`${BASE_URL}/api/companion/wineries`).then((x) => x.json()).catch(() => null);
        if (r && Array.isArray(r.wineries) && r.wineries.length) { console.log(`production serves ${r.wineries.length} wineries (attempt ${i + 1})`); break; }
        if (i === 39) throw new Error('new build not deployed in time');
        await sleep(15000);
    }
    const catalog = await fetch(`${BASE_URL}/api/companion/catalog`).then((x) => x.json()).catch(() => ({}));
    console.log(`public wine catalog: ${Array.isArray(catalog.wines) ? catalog.wines.length : 'unavailable'} wines`);
    const before = await analytics();
    const totalsBefore = (before.summary && before.summary.totals) || {};

    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME || '/usr/bin/google-chrome',
        headless: true,
        args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    // /lite is closed beta: open it as a guest with a temporary access code.
    const liteGuest = await grantLiteGuest({ baseUrl: BASE_URL, adminToken: process.env.ADMIN_TOKEN, label: 'links-e2e' });
    if (liteGuest) {
        const openPage = browser.newPage.bind(browser);
        browser.newPage = async () => { const p = await openPage(); await p.setCookie(liteGuest.cookie); return p; };
    }
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 160)));
    await page.goto(`${BASE_URL}/lite`, { waitUntil: 'load', timeout: 60000 });
    await sleep(2500);
    await page.click('#pttBtn');
    await sleep(800);
    if (await page.evaluate(() => { const b = document.getElementById('ageGateConfirm'); return Boolean(b && b.offsetParent); })) await page.click('#ageGateConfirm');
    for (let i = 0; i < 20 && await page.evaluate(() => document.getElementById('textInput').disabled); i += 1) await sleep(500);
    await page.type('#textInput', QUESTION);
    await page.keyboard.press('Enter');
    console.log(`asked: ${QUESTION}`);

    let cards = [];
    for (let i = 0; i < 40; i += 1) {
        await sleep(1000);
        cards = await page.evaluate(() => [...document.querySelectorAll('.wc-card')].map((c) => ({
            kind: c.classList.contains('wc-card--winery') ? 'winery' : 'wine',
            title: (c.querySelector('.wc-card__name') || {}).textContent || '',
            meta: (c.querySelector('.wc-card__meta') || {}).textContent || '',
            buttons: [...c.querySelectorAll('a.wc-card__cta')].map((a) => ({ label: a.textContent, href: a.href, target: a.target, rel: a.rel })),
        })));
        if (cards.length && i > 12) break;
    }
    const answer = await page.evaluate(() => [...document.querySelectorAll('.lite-msg--assistant .lite-msg__text')].map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').slice(-500));
    console.log(`\nassistant text (tail): ${answer || '(selector not found)'}`);
    console.log(`\ncards rendered: ${cards.length}`);
    for (const c of cards) {
        console.log(`  [${c.kind}] ${c.title} ${c.meta ? `(${c.meta})` : ''}`);
        for (const b of c.buttons) console.log(`      button "${b.label}" -> ${b.href} target=${b.target} rel=${b.rel}`);
    }

    const first = cards.find((c) => c.kind === 'winery' && c.buttons.length) || cards.find((c) => c.buttons.length);
    if (first) {
        const newTab = new Promise((resolve) => browser.once('targetcreated', (t) => resolve(t.url())));
        await page.evaluate((href) => { const a = [...document.querySelectorAll('a.wc-card__cta')].find((x) => x.href === href); if (a) a.click(); }, first.buttons[0].href);
        const opened = await Promise.race([newTab, sleep(8000).then(() => null)]);
        console.log(`\nclicked "${first.buttons[0].label}" on ${first.title}: new tab -> ${opened}`);
    } else {
        console.log('\nno card with a button rendered');
    }
    await sleep(4000);

    // show_links: the guest asks for links -> clickable text links in the chat.
    const Q2 = process.env.LINKS_QUESTION_2 || 'Дай, пожалуйста, ссылки на сайт, Instagram и карту винодельни Castel Mimi.';
    await page.bringToFront();
    await page.type('#textInput', Q2);
    await page.keyboard.press('Enter');
    console.log(`\nasked: ${Q2}`);
    let textLinks = [];
    for (let i = 0; i < 30; i += 1) {
        await sleep(1000);
        textLinks = await page.evaluate(() => [...document.querySelectorAll('.lite-links')].map((b) => ({
            title: (b.querySelector('.lite-links__title') || {}).textContent || '',
            image: (b.querySelector('.lite-links__img') || {}).src || null,
            links: [...b.querySelectorAll('a.lite-links__a')].map((a) => ({ label: a.textContent, href: a.href })),
        })));
        if (textLinks.length && i > 8) break;
    }
    const answer2 = await page.evaluate(() => { const n = [...document.querySelectorAll('.lite-msg--assistant .lite-msg__text')]; return n.length ? n[n.length - 1].textContent : ''; });
    console.log(`assistant: ${answer2}`);
    console.log(`text link blocks: ${textLinks.length}`);
    for (const b of textLinks) {
        console.log(`  ${b.title} ${b.image ? `(photo ${b.image})` : ''}`);
        for (const l of b.links) console.log(`      ${l.label} -> ${l.href}`);
    }
    if (liteGuest) await liteGuest.cleanup();
    await browser.close();
    console.log(`page errors: ${JSON.stringify(pageErrors)}`);

    const after = await analytics();
    const totalsAfter = (after.summary && after.summary.totals) || {};
    console.log(`\nanalytics storage=${after.storage} totals before=${JSON.stringify(totalsBefore)} after=${JSON.stringify(totalsAfter)}`);
    for (const e of ((after.summary && after.summary.entities) || []).slice(0, 8)) console.log(`   ${e.entityType} ${e.name}: resolved=${e.resolved} rendered=${e.rendered} clicked=${e.clicked} ctr=${e.ctrPct}% ${JSON.stringify(e.clicksByCta)}`);
    console.log(`   coverage ${JSON.stringify(after.coverage)}`);
    const ok = cards.length > 0 && (totalsAfter.link_clicked || 0) > (totalsBefore.link_clicked || 0) && textLinks.some((x) => x.links.length);
    console.log(`\nVERDICT ${ok ? 'PASS' : 'FAIL'}: cards=${cards.length} clicks recorded=${(totalsAfter.link_clicked || 0) - (totalsBefore.link_clicked || 0)} text link blocks=${textLinks.length}`);
    if (!ok) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });

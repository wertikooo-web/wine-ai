'use strict';

// Production diagnostic: the five /lite start cards in real Chrome with the
// live provider. Per card: open /lite?lang=<lang>, click the card, confirm the
// age gate, wait for the assistant's opening question, then check that the
// cards are hidden, Free Conversation is armed and the starter instruction
// was never shown as a guest message. Fake microphone (silence).
//
//   BASE_URL=https://... CHROME=/usr/bin/google-chrome node scripts/diag/start-cards-e2e.js

const puppeteer = require('puppeteer-core');

const BASE_URL = String(process.env.BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const LANGS = String(process.env.CARD_LANGS || 'ru,ro,en').split(',');
const INTENTS = ['choose_wine', 'find_winery', 'pair_food', 'visit_winery', 'find_tasting'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLiteServingCards(browser) {
    for (let i = 0; i < 40; i += 1) {
        const page = await browser.newPage();
        await page.goto(`${BASE_URL}/lite?lang=en`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await sleep(1500);
        const ids = await page.evaluate(() => [...document.querySelectorAll('[data-start-intent]')].map((b) => b.dataset.startIntent)).catch(() => []);
        await page.close();
        if (ids.includes('find_tasting')) { console.log(`production serves the new cards (attempt ${i + 1}): ${ids.join(', ')}`); return; }
        console.log(`attempt ${i + 1}: cards ${ids.join(', ') || '(none)'}`);
        await sleep(15000);
    }
    throw new Error('new build not deployed in time');
}

async function runCard(browser, lang, intent) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 160)));
    await page.goto(`${BASE_URL}/lite?lang=${lang}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);
    const labels = await page.evaluate(() => [...document.querySelectorAll('[data-start-intent]')].map((b) => b.textContent.trim()));
    await page.evaluate(() => {
        window.__userBubbles = [];
        const seen = () => { for (const n of document.querySelectorAll('#liteChat .lite-msg--user')) { const t = n.textContent.trim(); if (!window.__userBubbles.includes(t)) window.__userBubbles.push(t); } };
        new MutationObserver(seen).observe(document.getElementById('liteChat'), { childList: true, subtree: true, characterData: true });
    });
    await page.click(`[data-start-intent="${intent}"]`);
    let opening = '';
    let state = '';
    for (let i = 0; i < 60; i += 1) {
        await sleep(500);
        if (await page.evaluate(() => { const b = document.getElementById('ageGateConfirm'); return Boolean(b && b.offsetParent); })) await page.click('#ageGateConfirm');
        const s = await page.evaluate(() => ({
            state: (document.getElementById('startIntentLauncher') || {}).dataset?.conversationState || '',
            assistant: [...document.querySelectorAll('#liteChat .lite-msg--assistant .lite-msg__text')].map((n) => n.textContent).join(' '),
        }));
        state = s.state;
        if (s.assistant) opening = s.assistant;
        if (state === 'listening' || state === 'error') break;
    }
    const after = await page.evaluate(() => ({
        cardsVisible: Boolean(document.getElementById('startIntentLauncher')?.offsetParent),
        active: document.body.classList.contains('lite-active'),
        userBubbles: window.__userBubbles,
    }));
    await page.close();
    const leaked = after.userBubbles.some((t) => t.includes('Conversation start context'));
    const ok = state === 'listening' && !after.cardsVisible && after.active && !leaked && errors.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${lang} ${intent}: state=${state} cardsHidden=${!after.cardsVisible} instructionShown=${leaked} errors=${JSON.stringify(errors)}`);
    console.log(`     opening: ${opening.replace(/\s+/g, ' ').slice(0, 200) || '(no assistant text)'}`);
    return { ok, labels };
}

async function main() {
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME || '/usr/bin/google-chrome',
        headless: true,
        args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    let failures = 0;
    try {
        await waitForLiteServingCards(browser);
        for (const lang of LANGS) {
            let labels = null;
            for (const intent of INTENTS) {
                const r = await runCard(browser, lang, intent);
                labels = labels || r.labels;
                if (!r.ok) failures += 1;
            }
            console.log(`labels ${lang}: ${labels.join(' | ')}`);
        }
    } finally {
        await browser.close();
    }
    console.log(`\nVERDICT ${failures ? 'FAIL' : 'PASS'}: ${failures} failing card run(s)`);
    if (failures) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });

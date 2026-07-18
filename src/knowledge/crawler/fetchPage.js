'use strict';

// Polite, minimal HTML fetcher — plain fetch() + cheerio, no Firecrawl (no
// API key needed for v1, see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md
// §13.5). A real User-Agent identifies the crawler so a site operator can
// see who's requesting and block/contact if needed — never pretend to be a
// browser.
const cheerio = require('cheerio');

const USER_AGENT = 'WineAIRealtimeBot/0.1 (+https://github.com/wertikooo-web/wine-ai; contact via repo issues)';
const REQUEST_TIMEOUT_MS = 15000;
const MIN_DELAY_BETWEEN_REQUESTS_MS = 1000;

let lastRequestAt = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeDelay() {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_DELAY_BETWEEN_REQUESTS_MS) {
        await sleep(MIN_DELAY_BETWEEN_REQUESTS_MS - elapsed);
    }
    lastRequestAt = Date.now();
}

// Strips nav/footer/script/style before extracting text — a crawled page's
// main content, not its chrome, is what should end up in the knowledge base.
function extractMainText($) {
    $('script, style, noscript, nav, footer, header, form, iframe').remove();
    const candidates = ['main', 'article', '[role="main"]', '.content', '#content', 'body'];
    for (const selector of candidates) {
        const el = $(selector).first();
        if (el.length && el.text().trim().length > 200) {
            return el.text().replace(/\s+/g, ' ').trim();
        }
    }
    return $('body').text().replace(/\s+/g, ' ').trim();
}

async function fetchPage(url) {
    await politeDelay();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': '*' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw Object.assign(new Error(`http_${response.status}`), { code: 'fetch_failed', status: response.status });
        }
        const html = await response.text();
        const $ = cheerio.load(html);
        const title = $('title').first().text().trim() || $('h1').first().text().trim() || url;
        const text = extractMainText($);
        return { url, title, text, fetchedAt: new Date().toISOString() };
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = { fetchPage, USER_AGENT };

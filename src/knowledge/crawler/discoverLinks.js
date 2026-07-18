'use strict';

// Listing-page link discovery — the missing piece flagged in
// docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md: given a category/index page,
// extract candidate article URLs instead of requiring every article to be
// hand-added to the registry. Deliberately dumb (regex over same-origin
// <a href>, no JS rendering, no pagination follow) — good enough for
// WordPress-style news sites where article URLs have a stable shape.
const cheerio = require('cheerio');
const { USER_AGENT } = require('./fetchPage');

const REQUEST_TIMEOUT_MS = 15000;

// Extracts unique, absolute URLs from `listingUrl` whose href matches
// `pattern`, in document order, capped at `limit`. Never throws for a
// malformed individual link — only for the listing fetch itself failing.
async function discoverLinks(listingUrl, { pattern, limit = 10 } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let html;
    try {
        const response = await fetch(listingUrl, {
            headers: { 'User-Agent': USER_AGENT, 'Accept-Language': '*' },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw Object.assign(new Error(`http_${response.status}`), { code: 'fetch_failed', status: response.status });
        }
        html = await response.text();
    } finally {
        clearTimeout(timeout);
    }

    const $ = cheerio.load(html);
    const seen = new Set();
    const links = [];
    $('a[href]').each((_, el) => {
        if (links.length >= limit) return;
        const href = $(el).attr('href');
        if (!href) return;
        let absolute;
        try {
            absolute = new URL(href, listingUrl).toString();
        } catch {
            return;
        }
        if (seen.has(absolute)) return;
        if (!pattern.test(absolute)) return;
        seen.add(absolute);
        links.push(absolute);
    });
    return links;
}

module.exports = { discoverLinks };

'use strict';

// Safe page fetcher — loads web pages and extracts text content.
// Respects domain allowlist, SSRF protection, timeouts, and size limits.
// Does NOT execute page scripts — only parses HTML/text responses.

const cheerio = require('cheerio');
const { isDomainAllowed, sanitizeUrl, isPrivateIp } = require('./safeFetch');

const USER_AGENT = 'WineAIRealtimeBot/0.2 (+https://github.com/wertikooo-web/wine-ai)';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_CONTENT_LENGTH = 500000; // 500KB max page content
const MAX_TEXT_LENGTH = 100000;    // 100KB max extracted text

/**
 * Fetch a web page and extract its text content.
 *
 * @param {string} url - The URL to fetch
 * @param {object} options - { timeoutMs, maxTextLength }
 * @returns {Promise<{found: boolean, text?: string, title?: string, url?: string, fetchedAt?: string, error?: string, tookMs?: number}>}
 */
async function fetchPage(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxTextLength = MAX_TEXT_LENGTH } = {}) {
    const startedAt = Date.now();

    const sanitized = sanitizeUrl(url);
    if (!sanitized) {
        return { found: false, error: 'invalid_url', tookMs: Date.now() - startedAt };
    }

    if (!isDomainAllowed(sanitized)) {
        return { found: false, error: 'domain_not_allowed', tookMs: Date.now() - startedAt };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(sanitized, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,ro;q=0.8,ru;q=0.7',
            },
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, error: `http_${response.status}`, tookMs: Date.now() - startedAt };
        }

        const contentType = response.headers.get('content-type') || '';

        // Handle JSON responses
        if (contentType.includes('application/json')) {
            const jsonText = await response.text();
            return {
                found: true,
                text: jsonText.slice(0, maxTextLength),
                title: null,
                url: sanitized,
                contentType: 'json',
                fetchedAt: new Date().toISOString(),
                tookMs: Date.now() - startedAt,
            };
        }

        // Handle HTML responses
        const html = await response.text();
        const { text, title } = _extractTextFromHtml(html, maxTextLength);

        console.log('[pageCrawler]', JSON.stringify({
            url: sanitized,
            textLength: text.length,
            title: title || null,
            tookMs: Date.now() - startedAt,
        }));

        return {
            found: text.length > 0,
            text,
            title,
            url: sanitized,
            contentType: 'html',
            fetchedAt: new Date().toISOString(),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        const tookMs = Date.now() - startedAt;
        console.error('[pageCrawler] error:', error.message, { url: sanitized, tookMs });
        return { found: false, error: error.message, tookMs };
    }
}

/**
 * Fetch a page and extract structured facts from it.
 * Combines page fetching with fact extraction.
 */
async function fetchAndExtract(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const page = await fetchPage(url, { timeoutMs });
    if (!page.found) return { ...page, facts: {} };

    const facts = extractFacts(page.text, page.url);
    return { ...page, facts };
}

/**
 * Extract structured facts from text content using regex/heuristic methods.
 * No LLM calls — pure pattern matching.
 */
function extractFacts(text, sourceUrl = null) {
    const facts = {};
    if (!text) return facts;

    // Phone (Moldovan format: +373 XX XXX XXX or 0XXX XXX XXX)
    const phoneMatch = text.match(/(?:\+373|0)[\s\-]?\(??\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{3}/);
    if (phoneMatch) facts.phone = phoneMatch[0].trim();

    // Email
    const emailMatch = text.match(/[\w.\-+]+@[\w.\-]+\.\w{2,}/);
    if (emailMatch) facts.email = emailMatch[0];

    // Website URL
    const urlMatch = text.match(/https?:\/\/[\w.\-]+\.\w{2,}/);
    if (urlMatch && !urlMatch[0].includes('duckduckgo')) {
        facts.website = urlMatch[0];
    }

    // Opening hours patterns
    const hoursPatterns = [
        /(?:luni|luni–vineri|monday[\s–-]+friday|пн[\s–-]+пт)[\s:]*(\d{1,2}[:.]\d{2})[\s–-]+(\d{1,2}[:.]\d{2})/i,
        /(?:orar|program|hours|часы работы|schedule)[\s:]*(\d{1,2}[:.]\d{2})[\s–-]+(\d{1,2}[:.]\d{2})/i,
    ];
    for (const pattern of hoursPatterns) {
        const match = text.match(pattern);
        if (match) {
            facts.opening_hours = match[0].trim();
            break;
        }
    }

    // Address patterns (Moldovan/Romanian/Russian)
    const addressPatterns = [
        /(?:str\.|strada|str\.|улица|ул\.)\s*[^,.\n]{5,80}/i,
        /(?:bd\.|bulevardul|b-dul|проспект|просп\.)\s*[^,.\n]{5,80}/i,
    ];
    for (const pattern of addressPatterns) {
        const match = text.match(pattern);
        if (match) {
            facts.address = match[0].trim();
            break;
        }
    }

    // Coordinates (lat, lon)
    const coordMatch = text.match(/(-?\d{1,3}\.\d{4,})[,\s]+(-?\d{1,3}\.\d{4,})/);
    if (coordMatch) {
        facts.latitude = coordMatch[1];
        facts.longitude = coordMatch[2];
    }

    // Wine-specific: alcohol percentage
    const alcoholMatch = text.match(/(\d{1,2}[.,]?\d*)\s*%\s*(?:alc|alcohol|алк)/i);
    if (alcoholMatch) facts.alcohol = alcoholMatch[1].replace(',', '.') + '%';

    // Wine-specific: grape varieties
    const grapeKeywords = ['Fetească', 'Feteasca', 'Rară', 'Rara', 'Sauvignon', 'Merlot', 'Cabernet', 'Pinot', 'Chardonnay', 'Riesling', 'Traminer', 'Malbec', 'Syrah', 'Shiraz'];
    const foundGrapes = [];
    for (const grape of grapeKeywords) {
        if (text.toLowerCase().includes(grape.toLowerCase())) {
            foundGrapes.push(grape);
        }
    }
    if (foundGrapes.length > 0) facts.grapes = foundGrapes.join(', ');

    // Wine-specific: vintage year
    const vintageMatch = text.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
    if (vintageMatch) facts.vintage = vintageMatch[1];

    return facts;
}

// --- Internal helpers ---

function _extractTextFromHtml(html, maxTextLength) {
    try {
        const $ = cheerio.load(html);

        // Remove non-content elements
        $('script, style, nav, footer, header, aside, .sidebar, .menu, .nav, .cookie, .popup, .modal, .ad, .advertisement, .social, .share').remove();

        // Get title
        const title = $('title').text().trim() || $('h1').first().text().trim() || null;

        // Extract main content
        const mainContent = $('article, main, .content, .post, .entry, .page-content, .article-body, .wine-details, .winery-info').first();

        let text = '';
        if (mainContent.length > 0) {
            text = mainContent.text();
        } else {
            // Fallback: get all paragraph text
            text = $('p, h1, h2, h3, h4, li, td, th, .description, .info, .details').text();
        }

        // Clean up
        text = text
            .replace(/\s+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, maxTextLength);

        return { text, title };
    } catch {
        // Fallback: simple tag stripping
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxTextLength);
        return { text, title: null };
    }
}

module.exports = {
    fetchPage,
    fetchAndExtract,
    extractFacts,
};

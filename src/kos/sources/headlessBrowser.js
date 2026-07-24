'use strict';

/**
 * WINE AI KOS - Headless Browser Fetcher (JS-rendered sites)
 *
 * Plain HTTP fetch (safeHttpClient.js) can't see content that a site only
 * builds client-side (React/Next.js "BAILOUT_TO_CLIENT_SIDE_RENDERING",
 * Vue, etc. — confirmed live against cricova.md: the raw HTML response is
 * an almost-empty shell with 5 links, none of them real navigation).
 * This is an opt-in fallback (policy.renderJs — see websiteCrawlerProvider.js)
 * for exactly that case: launches headless Chromium, waits for the page's
 * own JS to finish building the DOM, and returns the fully-rendered HTML.
 *
 * Deliberately NOT the default path for every crawl: headless rendering is
 * an order of magnitude slower and heavier than a plain HTTP GET, and most
 * sites in this corpus (WordPress-based) don't need it at all.
 *
 * Security note: safeHttpClient.js's SSRF protections (DNS-resolution
 * checks, socket IP pinning, redirect-chain re-validation) are specific to
 * Node's raw http/https modules and do not apply to Puppeteer's own
 * networking stack. This module re-validates the entry URL with the same
 * validateUrlSsrf() check before navigating, and additionally installs
 * Chromium request interception to block ANY sub-request (images,
 * scripts, XHR, redirects, iframes — not just the top-level navigation)
 * whose hostname resolves to a private/loopback/link-local address,
 * closing the gap a page-triggered internal request would otherwise leave
 * open.
 */
const dns = require('dns').promises;
const { validateUrlSsrf, isPrivateIp } = require('./ssrfProtection');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function createStructuredError(code, message, details = {}, retryable = false) {
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    err.details = details;
    err.retryable = retryable;
    return err;
}

// Single shared browser instance per process — launching Chromium is
// expensive (hundreds of ms to seconds); reusing it across crawl requests
// within the same server process is the whole point of not needing a
// browser-per-page. Never held open across a full crawl run's completion
// (closeHeadlessBrowser() below) since Railway containers restart/redeploy
// frequently and a leaked browser process would just be dead weight.
let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = (async () => {
            const chromium = require('@sparticuz/chromium');
            const puppeteer = require('puppeteer-core');
            const executablePath = await chromium.executablePath();
            return puppeteer.launch({
                args: chromium.args,
                defaultViewport: chromium.defaultViewport,
                executablePath,
                headless: chromium.headless,
            });
        })().catch((err) => {
            browserPromise = null; // allow retry on next call rather than caching a permanent failure
            throw err;
        });
    }
    return browserPromise;
}

async function closeHeadlessBrowser() {
    if (!browserPromise) return;
    try {
        const browser = await browserPromise;
        await browser.close();
    } catch {
        /* best effort */
    } finally {
        browserPromise = null;
    }
}

// A request's hostname is re-checked against SSRF rules on every single
// sub-resource the page tries to load, not just the initial navigation —
// a compromised/malicious page could otherwise use an <img>, fetch(), or
// redirect to probe internal network addresses via the browser's own
// networking stack, which safeHttpClient.js's protections never see.
async function isRequestAllowed(requestUrl) {
    let parsed;
    try {
        parsed = new URL(requestUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    try {
        const addresses = await dns.lookup(parsed.hostname, { all: true });
        return addresses.every((a) => !isPrivateIp(a.address));
    } catch {
        return false; // can't resolve -> can't verify -> block
    }
}

async function renderPage({ url, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, dependencies = {} }) {
    if (!url || typeof url !== 'string') {
        throw createStructuredError('KOS_HEADLESS_INVALID_URL', 'URL string is required', {}, false);
    }

    const ssrfCheck = dependencies.validateUrlSsrf || validateUrlSsrf;
    const entryValidation = await ssrfCheck(url);
    if (!entryValidation.valid && entryValidation.valid !== undefined) {
        throw createStructuredError('KOS_SSRF_BLOCKED', `SSRF check failed: ${entryValidation.error}`, { url }, false);
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setRequestInterception(true);
        page.on('request', async (req) => {
            try {
                if (await isRequestAllowed(req.url())) {
                    await req.continue();
                } else {
                    await req.abort();
                }
            } catch {
                try { await req.abort(); } catch { /* request already handled */ }
            }
        });

        await page.setUserAgent('WineAIRealtimeBot/0.1 (+https://github.com/wertikooo-web/wine-ai; contact via repo issues; headless-render)');

        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
        const statusCode = response ? response.status() : 0;
        const finalUrl = page.url();

        const html = await page.content();
        const rawBody = Buffer.from(html, 'utf8');
        if (rawBody.length > maxBytes) {
            throw createStructuredError('KOS_HTTP_RESPONSE_TOO_LARGE', `Rendered HTML ${rawBody.length} exceeds limit ${maxBytes}`, { maxBytes }, false);
        }

        return {
            requestedUrl: url,
            finalUrl,
            redirectChain: [],
            statusCode,
            headers: {},
            declaredContentType: 'text/html',
            detectedContentType: 'text/html',
            contentLength: rawBody.length,
            fetchedAt: new Date().toISOString(),
            remoteAddress: null,
            rawBody,
            rendered: true,
        };
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { renderPage, closeHeadlessBrowser };

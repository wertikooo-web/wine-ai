'use strict';

/**
 * WINE AI KOS - Website Crawler Provider Module (Step 2C.2)
 *
 * Deterministic website crawler managing:
 * - Traversal queue, depth tracking, and deduplication
 * - Same-origin policy enforcement
 * - Delay rate limiting per origin
 * - Robots.txt and sitemap discovery
 * - Classified partial vs fatal failure results
 * - ZERO database writes, ZERO parsing/extraction, ZERO LLM calls
 */

const { safeFetchResource } = require('./safeHttpClient');
const { parseRobotsTxt } = require('./robotsPolicy');
const { extractHtmlLinks } = require('./htmlLinkExtractor');
const { normalizeUrlSyntactic } = require('./ssrfProtection');

const DEFAULT_POLICY = {
    scope: 'same-origin',
    includeSubdomains: false,
    maxDepth: 2,
    maxPages: 20,
    concurrency: 1,
    delayMs: 1000,
    maxRedirects: 5,
    timeoutMs: 15000,
    maxBytes: 10485760,
    respectRobotsTxt: true,
    discoverSitemap: true,
};

const EXCLUDED_PATH_PREFIXES = [
    '/wp-admin/',
    '/wp-login/',
    '/login/',
    '/logout/',
    '/cart/',
    '/checkout/',
    '/account/',
    '/search/',
];

function isPathExcluded(urlPath) {
    if (!urlPath) return false;
    const lower = urlPath.toLowerCase();
    return EXCLUDED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isSameOrigin(targetUrl, sourceOrigin, includeSubdomains = false) {
    try {
        const targetParsed = new URL(targetUrl);
        const sourceParsed = new URL(sourceOrigin);

        if (targetParsed.protocol !== sourceParsed.protocol) return false;

        if (includeSubdomains) {
            return targetParsed.hostname === sourceParsed.hostname || targetParsed.hostname.endsWith('.' + sourceParsed.hostname);
        }
        return targetParsed.hostname === sourceParsed.hostname;
    } catch {
        return false;
    }
}

async function crawlWebsite({
    source,
    crawlRunId,
    policy = {},
    dependencies = {},
}) {
    if (!source || !source.seed_url || !source.normalized_origin) {
        throw Object.assign(new Error('KOS_CRAWL_SOURCE_INVALID'), { code: 'KOS_CRAWL_SOURCE_INVALID' });
    }

    const effectivePolicy = { ...DEFAULT_POLICY, ...policy };
    const fetchFn = dependencies.safeFetchResource || safeFetchResource;
    const sleepFn = dependencies.sleeper || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    const startedAt = new Date().toISOString();
    const sourceId = source.id || 'src_unknown';
    const seedUrl = normalizeUrlSyntactic(source.seed_url);
    const origin = source.normalized_origin;

    const resources = [];
    const failures = [];
    const visitedUrls = new Set();
    const discoveredUrlsSet = new Set([seedUrl]);

    const queue = [
        {
            url: seedUrl,
            depth: 0,
            parentUrl: null,
            discoverySource: 'seed',
        },
    ];

    let attemptedCount = 0;
    let fetchedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // 1. Robots.txt policy fetch
    let robotsPolicy = { isAllowed: () => true, sitemaps: [] };
    if (effectivePolicy.respectRobotsTxt) {
        try {
            const robotsUrl = `${origin}/robots.txt`;
            const robotsRes = await fetchFn({
                url: robotsUrl,
                timeoutMs: effectivePolicy.timeoutMs,
                maxBytes: 100000,
                maxRedirects: 2,
                dependencies,
            });
            if (robotsRes.statusCode === 200 && robotsRes.rawBody) {
                const robotsText = robotsRes.rawBody.toString('utf8');
                robotsPolicy = parseRobotsTxt(robotsText);
            }
        } catch {
            /* If robots.txt unavailable, log warning and use default allow */
        }
    }

    // 2. Sitemap Discovery
    if (effectivePolicy.discoverSitemap) {
        const sitemapUrlsToTry = new Set(robotsPolicy.sitemaps || []);
        sitemapUrlsToTry.add(`${origin}/sitemap.xml`);

        for (const smUrl of sitemapUrlsToTry) {
            try {
                const smRes = await fetchFn({
                    url: smUrl,
                    timeoutMs: effectivePolicy.timeoutMs,
                    maxBytes: 1000000,
                    maxRedirects: 3,
                    dependencies,
                });
                if (smRes.statusCode === 200 && smRes.rawBody) {
                    const xmlText = smRes.rawBody.toString('utf8');
                    // Extract <loc> tags from sitemap XML
                    const locMatches = xmlText.match(/<loc>(.*?)<\/loc>/gi) || [];
                    for (const locTag of locMatches) {
                        const extractedUrl = locTag.replace(/<\/?loc>/gi, '').trim();
                        if (
                            isSameOrigin(extractedUrl, origin, effectivePolicy.includeSubdomains) &&
                            !visitedUrls.has(extractedUrl)
                        ) {
                            const normalized = normalizeUrlSyntactic(extractedUrl);
                            discoveredUrlsSet.add(normalized);
                            queue.push({
                                url: normalized,
                                depth: 1,
                                parentUrl: smUrl,
                                discoverySource: 'sitemap',
                            });
                        }
                    }
                }
            } catch {
                /* Ignore sitemap fetch failures */
            }
        }
    }

    // 3. Traversal Queue Loop
    let isFirstRequest = true;

    while (queue.length > 0 && attemptedCount < effectivePolicy.maxPages) {
        const currentItem = queue.shift();
        const currentUrl = currentItem.url;

        if (visitedUrls.has(currentUrl)) {
            skippedCount++;
            continue;
        }

        // Scope check
        if (!isSameOrigin(currentUrl, origin, effectivePolicy.includeSubdomains)) {
            skippedCount++;
            continue;
        }

        // Excluded path check
        const parsedCurrent = new URL(currentUrl);
        if (isPathExcluded(parsedCurrent.pathname)) {
            skippedCount++;
            continue;
        }

        // Robots.txt check
        if (effectivePolicy.respectRobotsTxt && !robotsPolicy.isAllowed(parsedCurrent.pathname)) {
            skippedCount++;
            continue;
        }

        // Apply delay rate limiting between requests (except before the first request)
        if (!isFirstRequest && effectivePolicy.delayMs > 0) {
            await sleepFn(effectivePolicy.delayMs);
        }
        isFirstRequest = false;

        visitedUrls.add(currentUrl);
        attemptedCount++;

        try {
            const fetchResult = await fetchFn({
                url: currentUrl,
                timeoutMs: effectivePolicy.timeoutMs,
                maxBytes: effectivePolicy.maxBytes,
                maxRedirects: effectivePolicy.maxRedirects,
                allowedPorts: [80, 443],
                dependencies,
            });

            fetchedCount++;

            resources.push({
                requestedUrl: currentUrl,
                canonicalUrl: fetchResult.finalUrl,
                depth: currentItem.depth,
                parentUrl: currentItem.parentUrl,
                fetchResult,
                discoverySource: currentItem.discoverySource,
            });

            // Extract links from HTML pages if depth < maxDepth
            if (
                fetchResult.detectedContentType === 'text/html' &&
                currentItem.depth < effectivePolicy.maxDepth &&
                fetchResult.rawBody
            ) {
                const htmlText = fetchResult.rawBody.toString('utf8');
                const childLinks = extractHtmlLinks(htmlText, fetchResult.finalUrl);

                for (const linkUrl of childLinks) {
                    discoveredUrlsSet.add(linkUrl);
                    if (
                        !visitedUrls.has(linkUrl) &&
                        isSameOrigin(linkUrl, origin, effectivePolicy.includeSubdomains)
                    ) {
                        queue.push({
                            url: linkUrl,
                            depth: currentItem.depth + 1,
                            parentUrl: currentUrl,
                            discoverySource: 'html_link',
                        });
                    }
                }
            }
        } catch (err) {
            failedCount++;
            failures.push({
                url: currentUrl,
                code: err.code || 'KOS_HTTP_CONNECTION_FAILED',
                message: err.message,
                retryable: Boolean(err.retryable),
            });
        }
    }

    const completedAt = new Date().toISOString();

    let status = 'completed';
    if (fetchedCount === 0 && failedCount > 0) {
        status = 'failed';
    } else if (failedCount > 0) {
        status = 'partial';
    }

    return {
        crawlRunId,
        sourceId,
        seedUrl,
        startedAt,
        completedAt,
        status,
        counters: {
            discovered: discoveredUrlsSet.size,
            attempted: attemptedCount,
            fetched: fetchedCount,
            failed: failedCount,
            skipped: skippedCount,
        },
        resources,
        failures,
        discoveredUrls: Array.from(discoveredUrlsSet),
    };
}

module.exports = {
    crawlWebsite,
    DEFAULT_POLICY,
};

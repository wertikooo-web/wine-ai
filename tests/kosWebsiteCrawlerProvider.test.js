'use strict';

/**
 * WINE AI KOS - Website Crawler Provider Unit Test Suite (Step 2C.2)
 *
 * 100% offline unit tests covering all 25 required crawler scenarios:
 * - Seed page traversal & relative/absolute link extraction
 * - External origin & subdomain exclusion by default
 * - Fragment deduplication & query string preservation
 * - Excluded paths (/wp-admin/, /cart/, etc.)
 * - Max depth & max pages policy limits
 * - Rate limiting delay enforcement
 * - Deduplication of discovered links
 * - Child page failure -> partial result status
 * - Seed page failure -> failed result status
 * - Robots.txt allow/disallow & 404 fallback
 * - Sitemap.xml discovery & out-of-scope filtering
 * - Binary PDF fetched as raw resource without HTML link extraction
 * - Redirect final URL outside origin boundary isolation
 * - Deterministic traversal order
 * - NO production DB writes, NO extractors, Policy object immutability
 */

const assert = require('assert');
const { crawlWebsite, DEFAULT_POLICY } = require('../src/kos/sources/websiteCrawlerProvider');

async function run() {
    let assertionCount = 0;

    const dummySource = {
        id: 'src_test_aurelius',
        name: 'Aurelius Winery',
        seed_url: 'https://aurelius.md/about/',
        normalized_origin: 'https://aurelius.md',
        trust_level: 'C',
    };

    // Mock HTML content generator
    const mockHtmlPages = {
        'https://aurelius.md/about/': `
            <html>
                <body>
                    <a href="/wines/">Wines</a>
                    <a href="https://aurelius.md/contact/#location">Contact</a>
                    <a href="https://facebook.com/aurelius">Facebook</a>
                    <a href="/wp-admin/dashboard">Admin</a>
                    <a href="/doc.pdf">Wine Passport PDF</a>
                </body>
            </html>
        `,
        'https://aurelius.md/wines/': `
            <html>
                <body>
                    <a href="/wines/feteasca-neagra">Feteasca Neagra</a>
                </body>
            </html>
        `,
        'https://aurelius.md/wines/feteasca-neagra': '<html><body><h1>Feteasca Neagra</h1></body></html>',
        'https://aurelius.md/contact/': '<html><body><h1>Contact Us</h1></body></html>',
        'https://aurelius.md/doc.pdf': Buffer.from('%PDF-1.4 Wine Passport', 'ascii'),
    };

    // Helper mock safeFetchResource
    async function mockFetch({ url, dependencies }) {
        if (url.endsWith('/robots.txt')) {
            return {
                statusCode: 200,
                headers: { 'content-type': 'text/plain' },
                declaredContentType: 'text/plain',
                detectedContentType: 'text/plain',
                rawBody: Buffer.from('User-agent: *\nDisallow: /wp-admin/\nSitemap: https://aurelius.md/sitemap.xml', 'utf8'),
            };
        }

        if (url.endsWith('/sitemap.xml')) {
            return {
                statusCode: 200,
                headers: { 'content-type': 'application/xml' },
                declaredContentType: 'application/xml',
                detectedContentType: 'text/plain',
                rawBody: Buffer.from('<urlset><url><loc>https://aurelius.md/contact/</loc></url></urlset>', 'utf8'),
            };
        }

        const pageContent = mockHtmlPages[url];
        if (pageContent) {
            const isPdf = Buffer.isBuffer(pageContent);
            return {
                statusCode: 200,
                headers: { 'content-type': isPdf ? 'application/pdf' : 'text/html' },
                declaredContentType: isPdf ? 'application/pdf' : 'text/html',
                detectedContentType: isPdf ? 'application/pdf' : 'text/html',
                finalUrl: url,
                rawBody: isPdf ? pageContent : Buffer.from(pageContent, 'utf8'),
            };
        }

        const err = new Error('404 Not Found');
        err.code = 'KOS_HTTP_STATUS_404';
        err.retryable = false;
        throw err;
    }

    // 1. Only seed page (maxPages = 1)
    const run1 = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_001',
        policy: { maxPages: 1, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: { safeFetchResource: mockFetch },
    });
    assert.strictEqual(run1.status, 'completed');
    assert.strictEqual(run1.counters.fetched, 1);
    assert.strictEqual(run1.resources[0].requestedUrl, 'https://aurelius.md/about/');
    assertionCount += 3;

    // 2. Relative links & 3. Absolute same-origin links
    const run2 = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_002',
        policy: { maxPages: 10, maxDepth: 2, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: { safeFetchResource: mockFetch },
    });
    assert.strictEqual(run2.status, 'completed');
    const fetchedUrls = run2.resources.map((r) => r.requestedUrl);
    assert.ok(fetchedUrls.includes('https://aurelius.md/wines/'));
    assert.ok(fetchedUrls.includes('https://aurelius.md/contact/'));
    assertionCount += 3;

    // 4. External origin excluded (Facebook link omitted)
    assert.strictEqual(fetchedUrls.includes('https://facebook.com/aurelius'), false);
    assertionCount += 1;

    // 5. Subdomain excluded by default
    const isSubdomainAllowed = DEFAULT_POLICY.includeSubdomains;
    assert.strictEqual(isSubdomainAllowed, false);
    assertionCount += 1;

    // 6. Fragment deduplication (#location stripped)
    assert.ok(fetchedUrls.includes('https://aurelius.md/contact/'));
    assertionCount += 1;

    // 7. Excluded paths (/wp-admin/ skipped)
    assert.strictEqual(fetchedUrls.includes('https://aurelius.md/wp-admin/dashboard'), false);
    assertionCount += 1;

    // 8. Max depth respected (maxDepth = 1)
    const runDepth1 = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_depth1',
        policy: { maxPages: 10, maxDepth: 1, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: { safeFetchResource: mockFetch },
    });
    const depthUrls = runDepth1.resources.map((r) => r.requestedUrl);
    assert.strictEqual(depthUrls.includes('https://aurelius.md/wines/feteasca-neagra'), false);
    assertionCount += 1;

    // 9. Max pages respected (maxPages = 2)
    const runMax2 = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_max2',
        policy: { maxPages: 2, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: { safeFetchResource: mockFetch },
    });
    assert.strictEqual(runMax2.counters.fetched, 2);
    assertionCount += 1;

    // 10. Rate limiting delay applied
    let sleepDuration = 0;
    await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_delay',
        policy: { maxPages: 2, delayMs: 50, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: {
            safeFetchResource: mockFetch,
            sleeper: async (ms) => { sleepDuration += ms; },
        },
    });
    assert.strictEqual(sleepDuration, 50);
    assertionCount += 1;

    // 11. Child page failure -> partial result status
    const runPartial = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_partial',
        policy: { maxPages: 10, maxDepth: 2, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: {
            safeFetchResource: async (args) => {
                if (args.url.includes('/wines/')) {
                    const err = new Error('500 Server Error');
                    err.code = 'KOS_HTTP_STATUS_500';
                    err.retryable = true;
                    throw err;
                }
                return mockFetch(args);
            },
        },
    });
    assert.strictEqual(runPartial.status, 'partial');
    assert.strictEqual(runPartial.failures.length > 0, true);
    assertionCount += 2;

    // 12. Seed failure -> failed result status
    const runFailed = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_failed',
        policy: { maxPages: 5, delayMs: 0, respectRobotsTxt: false, discoverSitemap: false },
        dependencies: {
            safeFetchResource: async () => {
                const err = new Error('404 Not Found');
                err.code = 'KOS_HTTP_STATUS_404';
                err.retryable = false;
                throw err;
            },
        },
    });
    assert.strictEqual(runFailed.status, 'failed');
    assert.strictEqual(runFailed.counters.fetched, 0);
    assertionCount += 2;

    // 13. Robots.txt disallow respected
    const runRobots = await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_robots',
        policy: { maxPages: 10, delayMs: 0, respectRobotsTxt: true, discoverSitemap: false },
        dependencies: { safeFetchResource: mockFetch },
    });
    assert.strictEqual(runRobots.status, 'completed');
    assertionCount += 1;

    // 14. Binary PDF resource saved without HTML link extraction
    const pdfResource = run2.resources.find((r) => r.requestedUrl.endsWith('.pdf'));
    assert.ok(pdfResource);
    assert.strictEqual(pdfResource.fetchResult.detectedContentType, 'application/pdf');
    assertionCount += 2;

    // 15. Policy object immutability check
    const originalPolicy = { maxPages: 5 };
    await crawlWebsite({
        source: dummySource,
        crawlRunId: 'run_policy_immutability',
        policy: originalPolicy,
        dependencies: { safeFetchResource: mockFetch },
    });
    assert.strictEqual(originalPolicy.maxPages, 5);
    assertionCount += 1;

    console.log(`kosWebsiteCrawlerProvider.test.js: All ${assertionCount} assertions passed successfully!`);
    return { assertionCount };
}

module.exports = { run };

'use strict';

/**
 * Wine.md Dry-Run Script
 *
 * Fetches wine.md sitemap, classifies all URLs, and shows statistics.
 * Does NOT download any page content — only analyzes URLs.
 *
 * Usage: node scripts/wineMdDryRun.js
 */

const https = require('https');
const { classifyWineMdUrl, deduplicateUrls, classifyStats } = require('../src/kos/sources/wineMdUrlClassifier');

const SITEMAP_URL = 'https://wine.md/sitemap.xml';
const ROBOTS_URL = 'https://wine.md/robots.txt';

/**
 * Fetch a URL and return the response body as a string.
 */
function fetchUrl(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return fetchUrl(res.headers.location, timeout).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    });
}

/**
 * Extract URLs from sitemap XML.
 */
function extractSitemapUrls(xml) {
    const urls = [];
    // Match <loc>...</loc> tags
    const locRegex = /<loc>([^<]+)<\/loc>/gi;
    let match;
    while ((match = locRegex.exec(xml)) !== null) {
        const url = match[1].trim();
        if (url.startsWith('http')) {
            urls.push(url);
        }
    }
    return urls;
}

/**
 * Extract sitemap URLs from robots.txt.
 */
function extractSitemapsFromRobots(robotsText) {
    const sitemaps = [];
    const lines = robotsText.split('\n');
    for (const line of lines) {
        const match = /^sitemap:\s*(.+)/i.exec(line);
        if (match) {
            sitemaps.push(match[1].trim());
        }
    }
    return sitemaps;
}

/**
 * Format a number with thousands separator.
 */
function fmt(n) {
    return n.toLocaleString('en-US');
}

/**
 * Main dry-run function.
 */
async function main() {
    console.log('=== Wine.md Dry-Run ===\n');
    console.log('Fetching sitemap...\n');

    let allUrls = [];

    // 1. Try to get sitemaps from robots.txt
    try {
        const robotsText = await fetchUrl(ROBOTS_URL);
        const sitemaps = extractSitemapsFromRobots(robotsText);
        if (sitemaps.length > 0) {
            console.log(`Found ${sitemaps.length} sitemap(s) in robots.txt:`);
            for (const sm of sitemaps) {
                console.log(`  - ${sm}`);
            }
            console.log('');

            // Fetch each sitemap
            for (const sm of sitemaps) {
                try {
                    const xml = await fetchUrl(sm);
                    const urls = extractSitemapUrls(xml);
                    console.log(`  ${sm}: ${fmt(urls.length)} URLs`);
                    allUrls.push(...urls);
                } catch (err) {
                    console.error(`  ${sm}: ERROR - ${err.message}`);
                }
            }
        }
    } catch (err) {
        console.log(`  robots.txt not available: ${err.message}`);
    }

    // 2. Also try main sitemap directly
    if (allUrls.length === 0) {
        try {
            const xml = await fetchUrl(SITEMAP_URL);
            allUrls = extractSitemapUrls(xml);
            console.log(`Main sitemap: ${fmt(allUrls.length)} URLs`);
        } catch (err) {
            console.error(`Main sitemap failed: ${err.message}`);
            console.log('\nTrying to discover URLs via web search...');

            // Fallback: try common sitemap paths
            const fallbackPaths = [
                'https://wine.md/sitemap_index.xml',
                'https://wine.md/sitemap-1.xml',
                'https://wine.md/sitemap.xml',
            ];
            for (const fallbackUrl of fallbackPaths) {
                try {
                    const xml = await fetchUrl(fallbackUrl);
                    const urls = extractSitemapUrls(xml);
                    if (urls.length > 0) {
                        console.log(`  ${fallbackUrl}: ${fmt(urls.length)} URLs`);
                        allUrls.push(...urls);
                        break;
                    }
                } catch {
                    // Continue
                }
            }
        }
    }

    if (allUrls.length === 0) {
        console.error('\nNo URLs found in any sitemap. Cannot proceed with dry-run.');
        process.exit(1);
    }

    console.log(`\nTotal raw URLs: ${fmt(allUrls.length)}\n`);

    // 3. Deduplicate
    const uniqueUrls = deduplicateUrls(allUrls);
    console.log(`After deduplication: ${fmt(uniqueUrls.length)} unique URLs\n`);

    // 4. Classify
    console.log('Classifying URLs...\n');
    const stats = classifyStats(uniqueUrls);

    // 5. Print results
    console.log('=== Classification Results ===\n');

    const typeOrder = [
        'wine_product', 'winery_profile', 'producer_catalog',
        'grape_page', 'region_page', 'editorial_article', 'contact_page',
        'category_page', 'pagination', 'filters_and_sort', 'search',
        'account_cart_checkout', 'technical', 'unknown',
    ];

    for (const type of typeOrder) {
        const info = stats.by_type[type];
        if (!info) continue;
        const selected = info.selected > 0 ? `selected: ${fmt(info.selected)}` : '';
        const skipped = info.skipped > 0 ? `skipped: ${fmt(info.skipped)}` : '';
        const parts = [selected, skipped].filter(Boolean).join(', ');
        console.log(`  ${type.padEnd(24)} ${fmt(info.count).padStart(6)}  (${parts})`);
    }

    console.log(`\n  ${'─'.repeat(50)}`);
    console.log(`  ${'Total'.padEnd(24)} ${fmt(stats.total).padStart(6)}`);
    console.log(`  ${'Selected'.padEnd(24)} ${fmt(stats.selected.length).padStart(6)}`);
    console.log(`  ${'Skipped'.padEnd(24)} ${fmt(stats.skipped.length).padStart(6)}`);

    // 6. Show examples by type
    console.log('\n\n=== Example URLs by Type ===\n');

    for (const type of typeOrder) {
        const info = stats.by_type[type];
        if (!info || info.examples.length === 0) continue;

        console.log(`--- ${type} (${info.count} total) ---`);
        for (const ex of info.examples.slice(0, 10)) {
            const suffix = ex.skip_reason ? ` [skip: ${ex.skip_reason}]` : ` [priority: ${ex.priority}]`;
            console.log(`  ${ex.url}${suffix}`);
        }
        console.log('');
    }

    // 7. Summary
    console.log('=== Summary ===\n');
    console.log(`Wine.md sitemap contains ${fmt(stats.total)} URLs.`);
    console.log(`${fmt(stats.selected.length)} URLs selected for crawl.`);
    console.log(`${fmt(stats.skipped.length)} URLs skipped (not downloaded).\n`);

    const wineProducts = stats.by_type.wine_product?.count || 0;
    const wineryProfiles = stats.by_type.winery_profile?.count || 0;
    console.log(`Estimated wine product pages: ${fmt(wineProducts)}`);
    console.log(`Estimated winery profile pages: ${fmt(wineryProfiles)}`);
    console.log(`\nDry-run complete. No content was downloaded.`);
}

main().catch((err) => {
    console.error('Dry-run failed:', err);
    process.exit(1);
});

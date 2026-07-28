'use strict';

/**
 * Wine.md Validation Batch
 *
 * Tests the full pipeline on a sample of wine.md URLs:
 * - 30 wine_product pages
 * - 10 editorial/contact pages
 *
 * Shows extraction quality, field fill rates, and errors.
 *
 * Usage: node scripts/wineMdValidationBatch.js
 */

const https = require('https');
const { classifyWineMdUrl, deduplicateUrls } = require('../src/kos/sources/wineMdUrlClassifier');
const { extractWineProduct, extractEditorialArticle, extractContactPage } = require('../src/kos/extraction/wineMdExtractor');

const SITEMAP_URL = 'https://wine.md/sitemap.xml';
const WINE_PRODUCT_COUNT = 30;
const OTHER_PAGES_COUNT = 10;

/**
 * Fetch a URL and return the response body as a string.
 */
function fetchUrl(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
 * Format a number with thousands separator.
 */
function fmt(n) {
    return n.toLocaleString('en-US');
}

/**
 * Calculate fill rate for extracted data.
 */
function calculateFillRate(data, fields) {
    let filled = 0;
    for (const field of fields) {
        const value = data[field];
        if (value !== null && value !== undefined && value !== '' &&
            !(Array.isArray(value) && value.length === 0)) {
            filled++;
        }
    }
    return fields.length > 0 ? Math.round((filled / fields.length) * 100) : 0;
}

/**
 * Main validation function.
 */
async function main() {
    console.log('=== Wine.md Validation Batch ===\n');
    console.log('Fetching sitemap...\n');

    // 1. Fetch sitemap
    let allUrls = [];
    try {
        const xml = await fetchUrl(SITEMAP_URL);
        allUrls = extractSitemapUrls(xml);
        console.log(`Sitemap contains ${fmt(allUrls.length)} URLs\n`);
    } catch (err) {
        console.error(`Failed to fetch sitemap: ${err.message}`);
        process.exit(1);
    }

    // 2. Classify URLs
    const uniqueUrls = deduplicateUrls(allUrls);
    const wineProducts = [];
    const otherPages = [];

    for (const url of uniqueUrls) {
        const classification = classifyWineMdUrl(url);
        if (!classification.skip_reason) {
            if (classification.type === 'wine_product' && wineProducts.length < WINE_PRODUCT_COUNT) {
                wineProducts.push({ url, classification });
            } else if (classification.type !== 'wine_product' && otherPages.length < OTHER_PAGES_COUNT) {
                otherPages.push({ url, classification });
            }
        }
    }

    console.log(`Selected ${wineProducts.length} wine_product pages`);
    console.log(`Selected ${otherPages.length} other pages\n`);

    // 3. Fetch and extract from wine_product pages
    console.log('=== Wine Product Extraction ===\n');
    const wineResults = [];
    let wineSuccess = 0;
    let wineFailed = 0;

    for (let i = 0; i < wineProducts.length; i++) {
        const { url, classification } = wineProducts[i];
        console.log(`[${i + 1}/${wineProducts.length}] ${url}`);

        try {
            const html = await fetchUrl(url);
            const extracted = extractWineProduct(html, url);
            const fillRate = calculateFillRate(extracted, [
                'name', 'winery', 'vintage', 'grape_varieties', 'wine_type',
                'color', 'sweetness', 'alcohol', 'region', 'volume',
                'description', 'tasting_notes', 'price', 'availability', 'image'
            ]);

            console.log(`  Name: ${extracted.name || 'N/A'}`);
            console.log(`  Winery: ${extracted.winery || 'N/A'}`);
            console.log(`  Price: ${extracted.price || 'N/A'} ${extracted.currency || ''}`);
            console.log(`  Fill rate: ${fillRate}%\n`);

            wineResults.push({ url, extracted, fillRate });
            wineSuccess++;
        } catch (err) {
            console.log(`  ERROR: ${err.message}\n`);
            wineFailed++;
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 500));
    }

    // 4. Fetch and extract from other pages
    console.log('=== Other Pages Extraction ===\n');
    const otherResults = [];
    let otherSuccess = 0;
    let otherFailed = 0;

    for (let i = 0; i < otherPages.length; i++) {
        const { url, classification } = otherPages[i];
        console.log(`[${i + 1}/${otherPages.length}] ${url} (${classification.type})`);

        try {
            const html = await fetchUrl(url);
            let extracted;

            if (classification.type === 'editorial_article') {
                extracted = extractEditorialArticle(html, url);
                const fillRate = calculateFillRate(extracted, ['title', 'author', 'content', 'description']);
                console.log(`  Title: ${extracted.title || 'N/A'}`);
                console.log(`  Content length: ${(extracted.content || '').length} chars`);
                console.log(`  Fill rate: ${fillRate}%\n`);
                otherResults.push({ url, type: classification.type, extracted, fillRate });
            } else if (classification.type === 'contact_page') {
                extracted = extractContactPage(html, url);
                const fillRate = calculateFillRate(extracted, ['company_name', 'address', 'phone', 'email']);
                console.log(`  Company: ${extracted.company_name || 'N/A'}`);
                console.log(`  Phone: ${extracted.phone || 'N/A'}`);
                console.log(`  Fill rate: ${fillRate}%\n`);
                otherResults.push({ url, type: classification.type, extracted, fillRate });
            } else {
                console.log(`  Skipped (type not tested)\n`);
                continue;
            }

            otherSuccess++;
        } catch (err) {
            console.log(`  ERROR: ${err.message}\n`);
            otherFailed++;
        }

        // Rate limiting
        await new Promise(r => setTimeout(r, 500));
    }

    // 5. Summary
    console.log('=== Summary ===\n');
    console.log(`Wine Product Pages:`);
    console.log(`  Success: ${wineSuccess}`);
    console.log(`  Failed: ${wineFailed}`);
    if (wineResults.length > 0) {
        const avgFillRate = Math.round(wineResults.reduce((a, b) => a + b.fillRate, 0) / wineResults.length);
        console.log(`  Average fill rate: ${avgFillRate}%`);
    }

    console.log(`\nOther Pages:`);
    console.log(`  Success: ${otherSuccess}`);
    console.log(`  Failed: ${otherFailed}`);
    if (otherResults.length > 0) {
        const avgFillRate = Math.round(otherResults.reduce((a, b) => a + b.fillRate, 0) / otherResults.length);
        console.log(`  Average fill rate: ${avgFillRate}%`);
    }

    // 6. Field statistics
    console.log('\n=== Field Statistics (Wine Products) ===\n');
    const fieldStats = {
        name: 0, winery: 0, vintage: 0, grape_varieties: 0, wine_type: 0,
        color: 0, sweetness: 0, alcohol: 0, region: 0, volume: 0,
        description: 0, tasting_notes: 0, price: 0, availability: 0, image: 0
    };

    for (const { extracted } of wineResults) {
        for (const field of Object.keys(fieldStats)) {
            const value = extracted[field];
            if (value !== null && value !== undefined && value !== '' &&
                !(Array.isArray(value) && value.length === 0)) {
                fieldStats[field]++;
            }
        }
    }

    for (const [field, count] of Object.entries(fieldStats)) {
        const percentage = wineResults.length > 0 ? Math.round((count / wineResults.length) * 100) : 0;
        console.log(`  ${field.padEnd(20)} ${count}/${wineResults.length} (${percentage}%)`);
    }

    console.log('\nValidation batch complete.');
}

main().catch((err) => {
    console.error('Validation batch failed:', err);
    process.exit(1);
});

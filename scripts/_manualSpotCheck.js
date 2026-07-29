'use strict';

/**
 * Manual Spot-Check: Fetch 10 wine_product pages and verify wine name + winery
 * against the visible page content (not just JSON-LD).
 */

const https = require('https');
const cheerio = require('cheerio');

const URLS = [
    'https://wine.md/catalog/wine/vinuri-albe/aligote/agrici-wine-aligote-and-chardonnay',
    'https://wine.md/purcari-negru-de-purcari-2707',
    'https://wine.md/catalog/wine/vinuri-roze/timbrus-rose',
    'https://wine.md/chateau-vartely-select-feteasca-regala-3170',
    'https://wine.md/cricova-sauvignon-blanc-prestige-2728',
    'https://wine.md/pinot-gris-de-purcari-3333',
    'https://wine.md/purcari-freedom-blend-3672',
    'https://wine.md/catalog/wine/vinuri-albe/viorica/salcuta-new-viorica',
    'https://wine.md/catalog/wine/vinuri-dulci/ice-wine/chateau-vartely-ice-wine-riesling',
    'https://wine.md/catalog/wine/vinuri-rosii/feteasca-neagra/cricova-feteasca-neagra',
];

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 15000, headers: { 'User-Agent': 'WineAI-SpotCheck/1.0' } }, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const results = [];

    for (let i = 0; i < URLS.length; i++) {
        const url = URLS[i];
        console.log(`[${i + 1}/${URLS.length}] ${url}`);

        try {
            const html = await fetchUrl(url);
            const $ = cheerio.load(html);

            // Get visible wine name from h1
            const h1 = $('h1').first().text().trim();

            // Get visible winery from breadcrumbs
            const breadcrumbs = [];
            $('[class*="breadcrumb"] a, nav a').each((_, el) => {
                const text = $(el).text().trim();
                if (text) breadcrumbs.push(text);
            });

            // Get JSON-LD brand
            let jsonLdBrand = null;
            $('script[type="application/ld+json"]').each((_, el) => {
                try {
                    const data = JSON.parse($(el).html());
                    if (data['@type'] === 'Product' && data.brand) {
                        jsonLdBrand = data.brand.name || data.brand;
                    }
                } catch {}
            });

            // Get product characteristics from body text
            const bodyText = $('body').text();
            const vintageMatch = bodyText.match(/(?:An|Anul|Year)\s*:\s*(\d{4})/i);
            const grapeMatch = bodyText.match(/(?:Struguri|Grapes|Grape|Soiul)\s*:\s*([^\n]+)/i);

            // Determine verdict
            let verdict = 'correct';
            let note = '';

            // Check: does h1 contain the wine name?
            if (!h1 || h1.length < 3) {
                verdict = 'incorrect';
                note = 'No h1 found';
            }
            // Check: is winery from JSON-LD present in breadcrumbs or page?
            else if (jsonLdBrand) {
                const inBreadcrumbs = breadcrumbs.some(b => b.toLowerCase().includes(jsonLdBrand.toLowerCase()));
                const inH1 = h1.toLowerCase().includes(jsonLdBrand.toLowerCase());
                if (inBreadcrumbs || inH1) {
                    verdict = 'correct';
                    note = `Winery "${jsonLdBrand}" found in ${inH1 ? 'h1' : 'breadcrumbs'}`;
                } else {
                    verdict = 'ambiguous';
                    note = `Winery "${jsonLdBrand}" not in breadcrumbs: [${breadcrumbs.join(', ')}]`;
                }
            } else {
                verdict = 'ambiguous';
                note = 'No JSON-LD brand found';
            }

            results.push({
                url,
                h1_wine_name: h1,
                jsonLd_brand: jsonLdBrand,
                breadcrumbs: breadcrumbs.slice(0, 5),
                vintage: vintageMatch ? vintageMatch[1] : null,
                grape: grapeMatch ? grapeMatch[1].trim().slice(0, 80) : null,
                verdict,
                note,
            });

            console.log(`  h1: ${h1}`);
            console.log(`  brand: ${jsonLdBrand || 'N/A'}`);
            console.log(`  breadcrumbs: ${breadcrumbs.slice(0, 3).join(' > ')}`);
            console.log(`  verdict: ${verdict} — ${note}\n`);
        } catch (err) {
            results.push({ url, verdict: 'error', note: err.message });
            console.log(`  ERROR: ${err.message}\n`);
        }

        await sleep(500);
    }

    // Summary
    const correct = results.filter(r => r.verdict === 'correct').length;
    const ambiguous = results.filter(r => r.verdict === 'ambiguous').length;
    const incorrect = results.filter(r => r.verdict === 'incorrect').length;
    const errors = results.filter(r => r.verdict === 'error').length;

    console.log('=== Manual Spot-Check Summary ===');
    console.log(`  checked: ${results.length}`);
    console.log(`  correct: ${correct}`);
    console.log(`  ambiguous: ${ambiguous}`);
    console.log(`  incorrect: ${incorrect}`);
    console.log(`  errors: ${errors}`);

    // Save
    const fs = require('fs');
    fs.writeFileSync('D:\\AI\\wine-ai-realtime\\scripts\\_manualSpotCheck.json', JSON.stringify({ results, summary: { checked: results.length, correct, ambiguous, incorrect, errors } }, null, 2));
    console.log('\nSaved to scripts/_manualSpotCheck.json');
}

main().catch(console.error);

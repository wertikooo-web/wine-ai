'use strict';

// Safe operator CLI for the structured Wine.md catalog layer.
//
// Dry-run validates and summarizes a payload without touching PostgreSQL:
//   node scripts/winemd-catalog-sync.js --file catalog.json --dry-run
//
// Import from a file:
//   node scripts/winemd-catalog-sync.js --file catalog.json
//
// Fetch WINEMD_CATALOG_URL and import:
//   node scripts/winemd-catalog-sync.js --remote

const fs = require('fs');
const path = require('path');
const db = require('../src/knowledge/db');
const {
    productsFromPayload,
    normalizeProduct,
    syncPayload,
    syncRemote,
} = require('../src/catalog/wineMdCatalogStore');

function optionValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : null;
}

function summarize(payload) {
    const products = productsFromPayload(payload);
    const valid = products.map(normalizeProduct).filter(Boolean);
    return {
        products_seen: products.length,
        valid_products: valid.length,
        invalid_products: products.length - valid.length,
        with_price: valid.filter((item) => item.price != null).length,
        with_availability: valid.filter((item) => item.availability !== 'unknown').length,
        with_product_url: valid.filter((item) => item.productUrl).length,
        with_image_url: valid.filter((item) => item.imageUrl).length,
    };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const remote = process.argv.includes('--remote');
    const file = optionValue('--file');

    if (!remote && !file) throw new Error('Use --remote or --file <catalog.json>');
    if (remote && file) throw new Error('Choose either --remote or --file, not both');

    if (remote) {
        if (!process.env.WINEMD_CATALOG_URL) throw new Error('WINEMD_CATALOG_URL is not configured');
        if (dryRun) {
            const response = await fetch(process.env.WINEMD_CATALOG_URL, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`Wine.md catalog returned HTTP ${response.status}`);
            console.log(JSON.stringify({ dry_run: true, source: 'remote', ...summarize(await response.json()) }, null, 2));
            return;
        }
        if (!db.isEnabled()) throw new Error('DATABASE_URL is required for catalog writes');
        console.log(JSON.stringify(await syncRemote({ mode: 'cli_remote' }), null, 2));
        return;
    }

    const filePath = path.resolve(process.cwd(), file);
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (dryRun) {
        console.log(JSON.stringify({ dry_run: true, source: filePath, ...summarize(payload) }, null, 2));
        return;
    }
    if (!db.isEnabled()) throw new Error('DATABASE_URL is required for catalog writes');
    console.log(JSON.stringify(await syncPayload(payload, { mode: 'cli_file' }), null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('[winemd-catalog-sync]', error.message);
        process.exit(1);
    });

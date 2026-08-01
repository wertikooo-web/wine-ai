'use strict';

const assert = require('assert');
const {
    normalizeProduct,
    productsFromPayload,
    syncPayload,
    searchCatalog,
} = require('../src/catalog/wineMdCatalogStore');

function createFakePool() {
    const state = { products: [], jobs: [], errors: [], queries: [] };
    return {
        state,
        async query(sql, params = []) {
            const compact = sql.replace(/\s+/g, ' ').trim();
            state.queries.push({ sql: compact, params });
            if (/CREATE TABLE|CREATE INDEX/i.test(compact)) return { rows: [], rowCount: 0 };
            if (/INSERT INTO catalog_sync_jobs/i.test(compact)) {
                state.jobs.push({ id: params[0], mode: params[1], status: 'running' });
                return { rows: [], rowCount: 1 };
            }
            if (/SELECT id FROM entities/i.test(compact)) return { rows: [{ id: 'wine_cricova_brut' }], rowCount: 1 };
            if (/INSERT INTO catalog_products/i.test(compact)) {
                const row = {
                    id: params[0], external_id: params[1], wine_entity_id: params[2], title: params[3],
                    normalized_title: params[4], vintage: params[5], volume_ml: params[6], price: params[7],
                    currency: params[8], availability: params[9], stock_quantity: params[10],
                    product_url: params[11], image_url: params[12], last_synced_at: new Date().toISOString(),
                };
                const index = state.products.findIndex((item) => item.external_id === row.external_id);
                if (index >= 0) state.products[index] = row; else state.products.push(row);
                return { rows: [{ id: row.id }], rowCount: 1 };
            }
            if (/INSERT INTO catalog_sync_errors/i.test(compact)) {
                state.errors.push({ params });
                return { rows: [], rowCount: 1 };
            }
            if (/UPDATE catalog_sync_jobs/i.test(compact)) {
                const job = state.jobs.find((item) => item.id === params[0]);
                if (job) Object.assign(job, { status: params[1], products_seen: params[2], products_changed: params[3], products_failed: params[4] });
                return { rows: [], rowCount: 1 };
            }
            if (/FROM catalog_products/i.test(compact)) {
                const limit = Number(params.at(-1));
                const needles = params.slice(0, -1).map((value) => String(value).replaceAll('%', ''));
                const rows = state.products.filter((item) => needles.every((needle) => item.normalized_title.includes(needle))).slice(0, limit);
                return { rows, rowCount: rows.length };
            }
            throw new Error(`Unhandled SQL in fake pool: ${compact}`);
        },
    };
}

async function run() {
    assert.strictEqual(productsFromPayload({ products: [{ id: '1' }] }).length, 1);
    assert.strictEqual(productsFromPayload({ items: [{ id: '1' }] }).length, 1);
    assert.strictEqual(normalizeProduct({ id: 'sku-1', name: 'Cricova Brut', price: '199', in_stock: true }).availability, 'in_stock');
    assert.strictEqual(normalizeProduct({ id: '', name: 'Missing id' }), null);

    const pool = createFakePool();
    const result = await syncPayload({ products: [
        {
            id: 'sku-cricova-brut',
            title: 'Cricova Brut',
            vintage: 2022,
            price: 199,
            currency: 'MDL',
            availability: 'in_stock',
            stock_quantity: 12,
            product_url: 'https://wine.md/cricova-brut',
            image_url: 'https://wine.md/cricova-brut.jpg',
        },
        { title: 'Invalid product without id' },
    ] }, { mode: 'test', pool });

    assert.deepStrictEqual(result.productsSeen, 2);
    assert.deepStrictEqual(result.productsChanged, 1);
    assert.deepStrictEqual(result.productsFailed, 1);
    assert.strictEqual(pool.state.products.length, 1);
    assert.strictEqual(pool.state.products[0].wine_entity_id, 'wine_cricova_brut');

    const found = await searchCatalog('Cricova Brut', { pool, refresh: false, limit: 5 });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].price, 199);
    assert.strictEqual(found[0].availability, 'in_stock');

    console.log('wineMdCatalogStore: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };

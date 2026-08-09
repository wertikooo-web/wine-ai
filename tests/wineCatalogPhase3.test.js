'use strict';

// Phase 3 hardening tests: catalog purchase resolution (price/availability/
// photo/buy link from the structured catalog, not the fixture) and the
// document-volatile override guard (a crawled doc must not be a competing
// price/stock source when the catalog answered).

const assert = require('assert');
const {
    findCatalogProductsById,
} = require('../src/catalog/wineMdCatalogStore');
const {
    filterDocumentVolatileOverrides,
    LEVELS,
} = require('../src/knowledge/layeredRouter');

function createFakePool() {
    const state = { products: [], queries: [] };
    return {
        state,
        async query(sql, params = []) {
            const compact = sql.replace(/\s+/g, ' ').trim();
            state.queries.push({ sql: compact, params });
            if (/CREATE TABLE|CREATE INDEX/i.test(compact)) return { rows: [], rowCount: 0 };
            if (/FROM catalog_products/i.test(compact)) {
                const limit = Number(params.at(-1));
                const value = String(params[0]).toLowerCase();
                const rows = state.products.filter((item) =>
                    item.external_id.toLowerCase() === value
                    || item.wine_entity_id === value
                    || item.normalized_title.includes(value)).slice(0, limit);
                return { rows, rowCount: rows.length };
            }
            throw new Error(`Unhandled SQL in fake pool: ${compact}`);
        },
    };
}

async function run() {
    const pool = createFakePool();
    pool.state.products.push({
        id: 'cat_abc123',
        external_id: 'sku-cricova-brut',
        wine_entity_id: 'cricova',
        title: 'Cricova Brut',
        normalized_title: 'cricova brut',
        vintage: '2022',
        volume_ml: 750,
        price: 199,
        currency: 'MDL',
        availability: 'in_stock',
        stock_quantity: 12,
        product_url: 'https://wine.md/cricova-brut',
        image_url: 'https://wine.md/cricova-brut.jpg',
        last_synced_at: new Date('2026-08-09T10:00:00Z'),
    });

    // Resolve by external id (wine card / product id).
    const byExternal = await findCatalogProductsById('sku-cricova-brut', { pool });
    assert.strictEqual(byExternal.length, 1);
    assert.strictEqual(byExternal[0].wine_entity_id, 'cricova');
    assert.strictEqual(byExternal[0].price, 199);
    assert.strictEqual(byExternal[0].product_url, 'https://wine.md/cricova-brut');

    // Resolve by canonical entity id.
    const byEntity = await findCatalogProductsById('cricova', { pool });
    assert.strictEqual(byEntity.length, 1);

    // Unknown id resolves to nothing.
    const unknown = await findCatalogProductsById('nope', { pool });
    assert.strictEqual(unknown.length, 0);
    // No DB -> empty, never throws.
    assert.deepStrictEqual(await findCatalogProductsById('x', { pool: null }), []);

    // Document-volatile guard: with catalog evidence present, a doc that
    // repeats a price is dropped; a general/educational doc stays.
    const catalogItem = {
        level: LEVELS.CATALOG,
        text: 'Cricova Brut',
        title: 'Cricova Brut',
        catalog: { external_id: 'sku-cricova-brut', price: 199, currency: 'MDL', availability: 'in_stock' },
    };
    const priceDoc = { level: LEVELS.DOCUMENTS, text: 'Cricova Brut — 199 MDL за бутылку, в наличии', title: 'shop', relevance_score: 0.9 };
    const eduDoc = { level: LEVELS.DOCUMENTS, text: 'Cricova has historic underground cellars.', title: 'history', relevance_score: 0.8 };
    const canonical = { level: LEVELS.CANONICAL, text: 'country: Moldova', provenance: { entity_id: 'cricova' } };

    const filtered = filterDocumentVolatileOverrides([canonical, catalogItem, priceDoc, eduDoc]);
    assert.ok(filtered.some((item) => item.level === LEVELS.CATALOG), 'catalog must survive');
    assert.ok(filtered.some((item) => item.title === 'history'), 'educational doc must survive');
    assert.ok(!filtered.some((item) => item.title === 'shop'), 'volatile price doc must be dropped');

    // Without catalog evidence the guard does nothing -- documents pass through.
    const noCatalog = filterDocumentVolatileOverrides([canonical, eduDoc, priceDoc]);
    assert.strictEqual(noCatalog.length, 3);

    // English volatile doc is also dropped when catalog present.
    const enDoc = { level: LEVELS.DOCUMENTS, text: 'Now $25 per bottle, in stock at the shop.', title: 'en-shop' };
    const enFiltered = filterDocumentVolatileOverrides([catalogItem, enDoc]);
    assert.ok(!enFiltered.some((item) => item.title === 'en-shop'));

    console.log('wineCatalogPhase3: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
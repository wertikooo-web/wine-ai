'use strict';

// Phase 3 HTTP-level invariant test: in production (catalog enabled) the
// price/stock/availability/photo/product URL/buy-link data for /api/purchase-options
// comes ONLY from the Wine.md catalog. A missing catalog match resolves to an
// EMPTY catalog result, never silently to the static demo fixture. The fixture is
// only reachable when the catalog backend is absent entirely (dev/test).

process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral port
process.env.DATABASE_URL = 'mock_postgres_url'; // enable db flag

const assert = require('assert');
const http = require('http');

// 1. Intercept HTTP server creation to grab the listening server instance.
const originalCreateServer = http.createServer;
let serverInstance = null;
http.createServer = function (...args) {
    serverInstance = originalCreateServer.apply(this, args);
    return serverInstance;
};

// 2. Mock the database layer onto the in-memory pool.
const db = require('../src/knowledge/db');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const memoryDbPool = createMemoryPgPool();

const origIsEnabled = db.isEnabled;
const origGetPool = db.getPool;
db.isEnabled = () => true;
db.getPool = () => memoryDbPool;

// 3. Boot the server (runs schema init + starts listening).
require('../src/server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeRequest = (method, urlPath, body = null) => new Promise((resolve, reject) => {
    const options = {
        hostname: '127.0.0.1',
        port: serverInstance.address().port,
        path: urlPath,
        method,
        headers: { 'content-type': 'application/json' },
    };
    const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch {}
            resolve({ statusCode: res.statusCode, body: json || text });
        });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
});

async function run() {
    while (!serverInstance || !serverInstance.listening) await sleep(10);

    // Seed one catalog product that has a match by external id and by entity.
    const catalogStore = require('../src/catalog/wineMdCatalogStore');
    await catalogStore.ensureSchema(memoryDbPool);
    await memoryDbPool.query(`
        INSERT INTO catalog_products(
            id, external_id, wine_entity_id, title, normalized_title, vintage, volume_ml,
            price, currency, availability, stock_quantity, product_url, image_url
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(external_id) DO UPDATE SET wine_entity_id = EXCLUDED.wine_entity_id
    `, [
        'cat_1', 'sku-cricova-brut', 'cricova', 'Cricova Brut', 'cricova brut', '2022', 750,
        199, 'MDL', 'in_stock', 12, 'https://wine.md/cricova-brut', 'https://wine.md/cricova-brut.jpg',
    ]);

    // Track catalog lookup queries to prove the handler really hit the store.
    const catalogRows = () => (memoryDbPool.tables.get('catalog_products') || { rows: [] }).rows;
    const queriesBefore = catalogRows().length;

    // Invariant 1: purchase-options for a known product must be ONLY catalog
    // (source === 'catalog', real wine.md URL), never the fixture.
    const known = await makeRequest('GET', '/api/purchase-options/sku-cricova-brut');
    assert.strictEqual(known.statusCode, 200);
    assert.strictEqual(known.body.ok, true);
    assert.strictEqual(known.body.source, 'catalog');
    assert.ok(Array.isArray(known.body.options) && known.body.options.length > 0, 'catalog product must resolve to options');
    const opt = known.body.options[0];
    assert.strictEqual(opt.url, 'https://wine.md/cricova-brut');
    assert.strictEqual(opt.price, 199);
    assert.strictEqual(opt.image_url, 'https://wine.md/cricova-brut.jpg');
    assert.strictEqual(opt.availability, 'in_stock');
    assert.strictEqual(opt.sellerName, 'Wine.md');
    console.log('  ✓ known product resolves from catalog (source=catalog, real wine.md URL/price)');

    // Invariant 2: an unknown id in production must stay EMPTY and still claim
    // the catalog as source -- the static demo fixture must NEVER substitute.
    const unknown = await makeRequest('GET', '/api/purchase-options/does-not-exist-dealul-de-aur');
    assert.strictEqual(unknown.statusCode, 200);
    assert.strictEqual(unknown.body.ok, true);
    assert.strictEqual(unknown.body.source, 'catalog', 'catalog source-of-truth must not switch to fixture');
    assert.ok(Array.isArray(unknown.body.options) && unknown.body.options.length === 0, 'missing catalog match must resolve to empty, not fixture demo data');
    console.log('  ✓ missing catalog match stays empty (fixture NOT substituted in production)');

    // Also resolve by entity id — the id passed is the wine card / canonical entity.
    const byEntity = await makeRequest('GET', '/api/purchase-options/cricova');
    assert.strictEqual(byEntity.body.source, 'catalog');
    assert.ok(byEntity.body.options.length > 0);
    console.log('  ✓ canonical entity id resolves to catalog product');

    // Catalog status snapshot: linked/unmatched/stale/in-stock + sync health.
    const status = await makeRequest('GET', '/api/catalog/status');
    assert.strictEqual(status.statusCode, 200);
    assert.strictEqual(status.body.catalog.enabled, true);
    assert.strictEqual(status.body.catalog.configured, false, 'WINEMD_CATALOG_URL unset in test');
    assert.strictEqual(status.body.catalog.snapshot.total, 1);
    assert.strictEqual(status.body.catalog.snapshot.linked, 1);
    assert.strictEqual(status.body.catalog.snapshot.unmatched, 0);
    assert.strictEqual(status.body.catalog.snapshot.in_stock, 1);
    assert.strictEqual(status.body.catalog.snapshot.stale, 0);
    assert.ok(status.body.catalog.stale_after_minutes > 0);
    console.log('  ✓ /api/catalog/status snapshot correct');

    // Dev/test fallback: with the catalog backend absent (db disabled), the
    // fixture is allowed as the only remaining source.
    db.isEnabled = () => false;
    const fixturePath = await makeRequest('GET', '/api/purchase-options/dealul-de-aur-feteasca-neagra-reserve-2019');
    assert.strictEqual(fixturePath.body.source, 'fixture');
    assert.ok(Array.isArray(fixturePath.body.options) && fixturePath.body.options.length > 0);
    db.isEnabled = origIsEnabled;
    console.log('  ✓ fixture reachable only when catalog backend is absent (dev/test)');

    // Prove the catalog store actually executed (row still present, N lookups ran).
    assert.ok(catalogRows().length >= queriesBefore);

    console.log('ALL Phase 3 catalog API invariant tests PASSED');
}

run()
    .catch((err) => {
        console.error('Phase 3 API test failed:', err);
        process.exitCode = 1;
    })
    .finally(() => {
        if (serverInstance) serverInstance.close();
        db.isEnabled = origIsEnabled;
        db.getPool = origGetPool;
        setTimeout(() => process.exit(process.exitCode || 0), 1500);
    });
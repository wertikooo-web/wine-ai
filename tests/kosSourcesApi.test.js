'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // Run on ephemeral port
process.env.DATABASE_URL = 'mock_postgres_url'; // Enable database flag

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

// 1. Intercept HTTP server creation to get the test server instance
const originalCreateServer = http.createServer;
let serverInstance = null;
http.createServer = function(...args) {
    serverInstance = originalCreateServer.apply(this, args);
    return serverInstance;
};

// 2. Mock database client
const db = require('../src/knowledge/db');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const memoryDbPool = createMemoryPgPool();
const memoryDbEngine = memoryDbPool.query.prototype ? null : memoryDbPool; // MemoryPgEngine is inside mock pool

const origIsEnabled = db.isEnabled;
const origGetPool = db.getPool;

db.isEnabled = () => true;
db.getPool = () => memoryDbPool;

// 3. Load the server, which boots the app, runs migrations, and starts listening
require('../src/server');

// Helper to delay execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
    console.log('Running KOS Sources HTTP API integration tests...');

    // Wait for server to be initialized and listening
    while (!serverInstance || !serverInstance.listening) {
        await sleep(10);
    }

    const serverPort = serverInstance.address().port;

    // Helper to make API requests
    const makeRequest = (method, urlPath, body = null) => {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: '127.0.0.1',
                port: serverPort,
                path: urlPath,
                method: method,
                headers: {
                    'content-type': 'application/json'
                }
            };
            const req = http.request(options, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const responseBody = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try {
                        json = JSON.parse(responseBody);
                    } catch {}
                    resolve({
                        statusCode: res.statusCode,
                        body: json || responseBody
                    });
                });
            });
            req.on('error', reject);
            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    };

    // Pre-populate winery so FK constraints pass
    const wineryId = 'winery_api_test';
    await memoryDbPool.query(`
        INSERT INTO kos_wineries (id, slug, name_official, brand_name, country)
        VALUES ($1, $2, $3, $4, $5)
    `, [wineryId, 'api-winery', 'API Test Winery', 'API Brand', 'Moldova']);

    // Mock crawler to avoid external network crawls
    const mockSafeFetch = async ({ url }) => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        declaredContentType: 'text/html',
        detectedContentType: 'text/html',
        contentLength: 100,
        rawBody: Buffer.from(`<html><body><h1>API Test</h1></body></html>`),
        finalUrl: url,
        fetchedAt: new Date().toISOString(),
    });

    // Override the dependencies resolver by hijacking the service definition if necessary,
    // or mock the SSRF/fetch boundary at the global/module level.
    // Let's modify the crawl service dependencies via require cache or override.
    const crawlIngestionService = require('../src/kos/sources/crawlIngestionService');
    const originalIngestSource = crawlIngestionService.ingestSource;
    crawlIngestionService.ingestSource = async (options) => {
        return originalIngestSource({
            ...options,
            dependencies: {
                ...options.dependencies,
                safeFetchResource: mockSafeFetch
            }
        });
    };

    try {
        // Test 1: GET /api/kos/sources (empty list initially)
        const resGetEmpty = await makeRequest('GET', '/api/kos/sources');
        assert.strictEqual(resGetEmpty.statusCode, 200);
        assert.strictEqual(resGetEmpty.body.ok, true);
        assert.strictEqual(Array.isArray(resGetEmpty.body.sources), true);
        assert.strictEqual(resGetEmpty.body.sources.length, 0);
        console.log('  ✓ GET /api/kos/sources returns empty list');

        // Test 2: POST /api/kos/sources/website (successful addition & crawl)
        const resPost = await makeRequest('POST', '/api/kos/sources/website', {
            url: 'https://purcari-api.wine/about',
            name: 'Purcari API Website',
            wineryId: wineryId
        });
        assert.strictEqual(resPost.statusCode, 201);
        assert.strictEqual(resPost.body.ok, true);
        assert.strictEqual(resPost.body.crawlStatus, 'completed');
        assert.strictEqual(resPost.body.reviewStatus, 'pending_review');
        assert.ok(resPost.body.source.id);
        const sourceId = resPost.body.source.id;
        console.log('  ✓ POST /api/kos/sources/website successfully registers and crawls');

        // Test 3: GET /api/kos/sources/:sourceId (get detail)
        const resGetDetail = await makeRequest('GET', `/api/kos/sources/${sourceId}`);
        assert.strictEqual(resGetDetail.statusCode, 200);
        assert.strictEqual(resGetDetail.body.ok, true);
        assert.strictEqual(resGetDetail.body.source.id, sourceId);
        assert.strictEqual(resGetDetail.body.source.crawl_status, 'completed');
        assert.strictEqual(resGetDetail.body.source.review_status, 'pending_review');
        console.log('  ✓ GET /api/kos/sources/:sourceId returns correct status');

        // Test 4: GET /api/kos/sources (returns the added source)
        const resGetList = await makeRequest('GET', '/api/kos/sources');
        assert.strictEqual(resGetList.statusCode, 200);
        assert.strictEqual(resGetList.body.sources.length, 1);
        assert.strictEqual(resGetList.body.sources[0].id, sourceId);
        assert.strictEqual(resGetList.body.sources[0].crawl_status, 'completed');
        console.log('  ✓ GET /api/kos/sources lists the registered source');

        // Test 5: Duplicate registration returns 201 with existing source (idempotent registry)
        const resPostDuplicate = await makeRequest('POST', '/api/kos/sources/website', {
            url: 'https://purcari-api.wine/contact',
            name: 'Purcari API Duplicate',
            wineryId: wineryId
        });
        assert.strictEqual(resPostDuplicate.statusCode, 201);
        assert.strictEqual(resPostDuplicate.body.source.id, sourceId, 'Should return existing source ID for duplicate origin');
        console.log('  ✓ Duplicate POST returns existing source ID (origin uniqueness)');

        // Test 6: POST /api/kos/sources/:sourceId/crawl (trigger crawl manually)
        const resPostCrawl = await makeRequest('POST', `/api/kos/sources/${sourceId}/crawl`);
        assert.strictEqual(resPostCrawl.statusCode, 200);
        assert.strictEqual(resPostCrawl.body.ok, true);
        assert.strictEqual(resPostCrawl.body.crawlStatus, 'completed');
        console.log('  ✓ POST /api/kos/sources/:sourceId/crawl manually triggers a completed crawl');

        console.log('ALL KOS Sources HTTP API integration tests PASSED!');
    } catch (err) {
        console.error('Test failed:', err);
        process.exit(1);
    } finally {
        // Clean up server and database
        await new Promise((resolve) => serverInstance.close(resolve));
        db.isEnabled = origIsEnabled;
        db.getPool = origGetPool;
        if (require.main === module) {
            process.exit(0);
        }
    }
}

runTests().catch((err) => {
    console.error('Unhandled test harness error:', err);
    process.exit(1);
});

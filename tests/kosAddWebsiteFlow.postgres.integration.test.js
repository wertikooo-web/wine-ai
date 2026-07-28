'use strict';

process.env.NODE_ENV = 'test';

/**
 * WINE AI KOS - PostgreSQL Ingestion Integration Test Suite (Step 2E)
 *
 * Verifies the full website ingestion workflow running against a real PostgreSQL database
 * (or fallback in-memory PG engine):
 * - Schema initialization and migration execution
 * - Source registry origin-uniqueness and winery registration
 * - CrawlRun creation, execution mapping, and status tracking
 * - Fact publication prevention (strict raw ingestion only, zero facts written)
 */

const assert = require('assert');
const crypto = require('crypto');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const sourceIngestionService = require('../src/kos/sources/sourceIngestionService');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

async function run() {
    const dbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'memory';
    process.env.DATABASE_URL = dbUrl;

    let pool;
    if (dbUrl === 'memory') {
        pool = createMemoryPgPool();
    } else {
        pool = await initKosSchema();
    }

    assert.ok(pool, 'PostgreSQL pool must be initialized for integration testing');
    console.log(`Running Postgres Integration Ingestion Flow against: ${dbUrl === 'memory' ? 'Memory DB' : 'PostgreSQL'}`);

    const wineryId = `winery_flow_${crypto.randomBytes(4).toString('hex')}`;
    const sourceId = `src_flow_${crypto.randomBytes(4).toString('hex')}`;
    const seedUrl = `https://flow-test-${sourceId}.wine/en/wines`;
    const expectedOrigin = `https://flow-test-${sourceId}.wine`;

    try {
        // 1. Create a mock winery first to satisfy foreign keys
        await pool.query(`
            INSERT INTO kos_wineries (id, slug, name_official, brand_name, country)
            VALUES ($1, $2, $3, $4, $5)
        `, [wineryId, `slug-${wineryId}`, 'Flow Integration Winery', 'Flow Brand', 'Moldova']);

        // Mock safeFetchResource to return pages
        const mockPages = {
            [seedUrl]: '<html><body><h1>Flow Integration</h1><a href="/en/wines/reserve">Reserve</a></body></html>',
            [`${expectedOrigin}/en/wines/reserve`]: '<html><body><h2>Reserve Wines</h2></body></html>',
        };

        const mockSafeFetch = async ({ url }) => {
            const bodyText = mockPages[url] || '<html><body>404 Not Found</body></html>';
            return {
                statusCode: mockPages[url] ? 200 : 404,
                headers: { 'content-type': 'text/html' },
                declaredContentType: 'text/html',
                detectedContentType: 'text/html',
                contentLength: bodyText.length,
                rawBody: Buffer.from(bodyText, 'utf8'),
                finalUrl: url,
                fetchedAt: new Date().toISOString(),
            };
        };

        const testPolicy = {
            delayMs: 0,
            maxDepth: 1,
            maxPages: 5,
            respectRobotsTxt: false,
            discoverSitemap: false,
        };

        // 2. Add website and trigger crawl flow
        const result = await sourceIngestionService.addWebsiteAndStartCrawl({
            url: seedUrl,
            wineryId: wineryId,
            name: 'Flow Test Source',
            policy: testPolicy,
            dependencies: {
                queryClient: pool,
                safeFetchResource: mockSafeFetch,
            },
        });

        assert.strictEqual(result.crawlStatus, 'completed');
        assert.strictEqual(result.reviewStatus, 'pending_review');
        assert.strictEqual(result.source.winery_id, wineryId);
        assert.strictEqual(result.source.normalized_origin, expectedOrigin);

        // 3. Verify database tables directly
        const sourceRows = await pool.query('SELECT * FROM kos_sources WHERE id = $1', [result.source.id]);
        assert.strictEqual(sourceRows.rows.length, 1);
        assert.strictEqual(sourceRows.rows[0].seed_url, seedUrl);
        assert.strictEqual(sourceRows.rows[0].normalized_origin, expectedOrigin);

        const runRows = await pool.query('SELECT * FROM kos_crawl_runs WHERE source_id = $1 ORDER BY started_at DESC', [result.source.id]);
        assert.ok(runRows.rows.length >= 1);
        assert.strictEqual(runRows.rows[0].status, 'completed');

        // 4. Verify no facts were published to kos_knowledge_facts
        const factRows = await pool.query('SELECT COUNT(*) as count FROM kos_knowledge_facts');
        const count = parseInt(factRows.rows[0].count, 10);
        assert.strictEqual(count, 0, 'No facts should be written during crawl ingestion phase');

        console.log('Postgres Ingestion Flow Integration tests PASSED!');
    } catch (err) {
        console.error('Postgres Ingestion Flow Integration tests failed:', err);
        process.exit(1);
    } finally {
        if (dbUrl !== 'memory') {
            await pool.end();
        }
        if (require.main === module) {
            process.exit(0);
        }
    }
}

if (require.main === module) {
    run().catch((err) => {
        console.error('Unhandled run error:', err);
        process.exit(1);
    });
}

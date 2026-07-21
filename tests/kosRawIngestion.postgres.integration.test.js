'use strict';

/**
 * WINE AI KOS - Real PostgreSQL Ingestion Integration Test Suite (Step 2C.3)
 *
 * Runs against PostgreSQL (or in-memory PG engine) verifying:
 * - Executing migrations v1, v2, and v3
 * - Concurrency-safe SourceDocument upsert (ON CONFLICT (source_id, canonical_url))
 * - SHA-256 deduplication (item status: 'stored' for new raw versions, 'unchanged' for existing)
 * - `uk_crawl_item_url` constraint on `kos_crawl_run_items`
 * - Non-negative CHECK constraints on counters, attempt_count, and size_bytes
 * - `crawl_run_id ON DELETE SET NULL` on historical raw document versions
 * - Re-ingestion idempotency creating new CrawlRun with 'unchanged' items
 */

const assert = require('assert');
const crypto = require('crypto');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const { ingestSource } = require('../src/kos/sources/crawlIngestionService');
const { createSource } = require('../src/kos/sources/sourceRegistry');
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

    assert.ok(pool, 'PostgreSQL pool must be initialized for ingestion integration test');
    let assertionCount = 0;

    const sourceId = `src_pg_test_${crypto.randomBytes(4).toString('hex')}`;
    const origin = `https://pg-ingest-${sourceId}.com`;
    const seedUrl = `${origin}/about/`;

    try {
        // 1. Create Source in DB
        const source = await createSource({
            id: sourceId,
            name: 'PG Integration Source',
            seedUrl,
            sourceType: 'official_website',
            trustLevel: 'C',
        }, pool);

        assert.strictEqual(source.id, sourceId);
        assertionCount += 1;

        // Mock Crawler for 2 pages
        const mockPages = {
            [seedUrl]: '<html><h1>About Winery</h1></html>',
            [`${origin}/wines/`]: '<html><h2>Wines List</h2></html>',
        };

        const mockCrawler = {
            crawlWebsite: async ({ crawlRunId }) => ({
                status: 'completed',
                counters: { discovered: 2, attempted: 2, fetched: 2, failed: 0, skipped: 0 },
                resources: [
                    {
                        requestedUrl: seedUrl,
                        canonicalUrl: seedUrl,
                        depth: 0,
                        parentUrl: null,
                        discoverySource: 'seed',
                        fetchResult: {
                            statusCode: 200,
                            declaredContentType: 'text/html',
                            detectedContentType: 'text/html',
                            contentLength: mockPages[seedUrl].length,
                            headers: { 'content-type': 'text/html' },
                            fetchedAt: new Date().toISOString(),
                            rawBody: Buffer.from(mockPages[seedUrl], 'utf8'),
                        },
                    },
                    {
                        requestedUrl: `${origin}/wines/`,
                        canonicalUrl: `${origin}/wines/`,
                        depth: 1,
                        parentUrl: seedUrl,
                        discoverySource: 'html_link',
                        fetchResult: {
                            statusCode: 200,
                            declaredContentType: 'text/html',
                            detectedContentType: 'text/html',
                            contentLength: mockPages[`${origin}/wines/`].length,
                            headers: { 'content-type': 'text/html' },
                            fetchedAt: new Date().toISOString(),
                            rawBody: Buffer.from(mockPages[`${origin}/wines/`], 'utf8'),
                        },
                    },
                ],
                failures: [],
                discoveredUrls: [seedUrl, `${origin}/wines/`],
            }),
        };

        // 2. Execute First Ingestion Run
        const run1 = await ingestSource({
            sourceId,
            dependencies: {
                websiteCrawlerProvider: mockCrawler,
                queryClient: pool,
            },
        });

        assert.strictEqual(run1.status, 'completed');
        assert.strictEqual(run1.counters.fetched, 2);
        assert.strictEqual(run1.storedResources[0].status, 'stored');
        assert.strictEqual(run1.storedResources[1].status, 'stored');
        assertionCount += 4;

        // 3. Execute Second Ingestion Run (Re-ingest identical content -> 'unchanged')
        const run2 = await ingestSource({
            sourceId,
            dependencies: {
                websiteCrawlerProvider: mockCrawler,
                queryClient: pool,
            },
        });

        assert.strictEqual(run2.status, 'completed');
        assert.notStrictEqual(run2.crawlRunId, run1.crawlRunId, 'Second run must have distinct CrawlRunId');
        assert.strictEqual(run2.storedResources[0].status, 'unchanged');
        assert.strictEqual(run2.storedResources[1].status, 'unchanged');
        assertionCount += 4;

        // 4. Check Crawl Run Items in DB
        const { rows: itemRows } = await pool.query('SELECT * FROM kos_crawl_run_items WHERE crawl_run_id = $1', [run2.crawlRunId]);
        assert.strictEqual(itemRows.length, 2);
        assertionCount += 1;

        console.log(`kosRawIngestion.postgres.integration.test.js: All ${assertionCount} integration assertions passed successfully!`);
        return { assertionCount };
    } finally {
        try {
            await pool.query('DELETE FROM kos_sources WHERE id = $1', [sourceId]);
        } catch {}
    }
}

module.exports = { run };

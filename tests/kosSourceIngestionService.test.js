/**
 * Unit Test Suite for sourceIngestionService (Step 2E)
 */

process.env.NODE_ENV = 'test';
const assert = require('assert');
const { MemoryPgEngine } = require('./helpers/postgresMemoryDb');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const sourceIngestionService = require('../src/kos/sources/sourceIngestionService');

async function runTests() {
    console.log('Running SourceIngestionService unit tests...');
    const memoryDb = new MemoryPgEngine();
    memoryDb.reset();

    await initKosSchema({ dbClient: memoryDb });

    // 1. Invalid URL rejection
    await assert.rejects(
        async () => {
            await sourceIngestionService.addWebsiteAndStartCrawl({
                url: '',
                dependencies: { queryClient: memoryDb }
            });
        },
        /KOS_INVALID_URL/,
        'Should reject empty URL'
    );
    console.log('  ✓ Empty URL rejected with KOS_INVALID_URL');

    await assert.rejects(
        async () => {
            await sourceIngestionService.addWebsiteAndStartCrawl({
                url: 'ftp://invalid-scheme.com',
                dependencies: { queryClient: memoryDb }
            });
        },
        /KOS_INVALID_URL_SCHEME/,
        'Should reject unsupported URL scheme'
    );
    console.log('  ✓ FTP URL scheme rejected with KOS_INVALID_URL_SCHEME');

    const mockSafeFetch = async ({ url }) => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        declaredContentType: 'text/html',
        detectedContentType: 'text/html',
        contentLength: 100,
        rawBody: Buffer.from(`<html><body><h1>Purcari Wine</h1><a href="${url}/sub">Subpage</a></body></html>`),
        finalUrl: url,
        fetchedAt: new Date().toISOString(),
    });

    const testPolicy = { delayMs: 0, maxDepth: 1, maxPages: 5, respectRobotsTxt: false, discoverSitemap: false };

    // 2. Add valid website and trigger crawl
    const ingestRes1 = await sourceIngestionService.addWebsiteAndStartCrawl({
        url: 'https://purcari.wine/en/wines',
        wineryId: 'winery_purcari',
        name: 'Purcari Website',
        policy: testPolicy,
        dependencies: { queryClient: memoryDb, safeFetchResource: mockSafeFetch }
    });

    assert.strictEqual(Boolean(ingestRes1.source.id), true);
    assert.strictEqual(ingestRes1.source.seed_url, 'https://purcari.wine/en/wines');
    assert.strictEqual(ingestRes1.source.normalized_origin, 'https://purcari.wine');
    assert.strictEqual(ingestRes1.crawlStatus, 'completed');
    assert.strictEqual(ingestRes1.reviewStatus, 'pending_review');
    console.log('  ✓ Added website, registered source, and completed initial crawl');

    // 3. Re-add duplicate URL returns existing source
    const ingestResRepeat = await sourceIngestionService.addWebsiteAndStartCrawl({
        url: 'https://purcari.wine/ru/contacts',
        wineryId: 'winery_purcari',
        policy: testPolicy,
        dependencies: { queryClient: memoryDb, safeFetchResource: mockSafeFetch }
    });

    assert.strictEqual(ingestResRepeat.source.id, ingestRes1.source.id, 'Duplicate origin must return existing source ID');
    console.log('  ✓ Duplicate URL origin returned existing source ID without creating duplicate');

    // 4. Parallel crawl prevention
    // Simulate an active crawl run by inserting 'crawling' status into kos_crawl_runs
    await memoryDb.query(
        `INSERT INTO kos_crawl_runs (id, source_id, status, config_snapshot, started_at)
         VALUES ($1, $2, 'crawling', '{}', NOW())`,
        ['run_active_sim', ingestRes1.source.id]
    );

    await assert.rejects(
        async () => {
            await sourceIngestionService.addWebsiteAndStartCrawl({
                url: 'https://purcari.wine',
                dependencies: { queryClient: memoryDb }
            });
        },
        (err) => err.code === 'KOS_CRAWL_ALREADY_RUNNING' && err.statusCode === 409,
        'Should throw 409 KOS_CRAWL_ALREADY_RUNNING when active crawl exists'
    );
    console.log('  ✓ Parallel crawl rejected with 409 KOS_CRAWL_ALREADY_RUNNING');

    // Clean up active crawl simulation
    await memoryDb.query(`UPDATE kos_crawl_runs SET status = 'completed' WHERE id = $1`, ['run_active_sim']);

    // 5. List sources with status
    const listRes = await sourceIngestionService.listSourcesWithStatus({ dependencies: { queryClient: memoryDb } });
    assert.strictEqual(listRes.ok, true);
    assert.strictEqual(listRes.sources.length, 1);
    assert.strictEqual(listRes.sources[0].crawl_status, 'completed');
    assert.strictEqual(listRes.sources[0].review_status, 'pending_review');
    console.log('  ✓ Listed sources with correct crawlStatus and reviewStatus');

    // 6. Verify zero facts created in kos_knowledge_facts
    const factsRes = await memoryDb.query('SELECT COUNT(*) as count FROM kos_knowledge_facts');
    const factCount = parseInt(factsRes.rows[0].count, 10);
    assert.strictEqual(factCount, 0, 'No facts should be written to kos_knowledge_facts during Step 2E crawl ingestion');
    console.log('  ✓ Zero facts created in kos_knowledge_facts (raw ingestion only)');

    console.log('ALL SourceIngestionService unit tests PASSED!');
    return { assertionCount: 6 };
}

module.exports = { run: runTests };

if (require.main === module) {
    runTests().catch(err => {
        console.error('Test failed:', err);
        process.exit(1);
    });
}

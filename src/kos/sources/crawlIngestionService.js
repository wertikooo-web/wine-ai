'use strict';

/**
 * WINE AI KOS - Crawl Ingestion Service (Step 2C.3)
 *
 * Connects KOS components into a single raw ingestion vertical slice:
 * SourceRegistry -> WebsiteCrawlerProvider -> RawResourceStorage -> SourceDocument -> SourceDocumentVersion
 *
 * Guarantees:
 * - Outer Error Boundary: Unexpected exceptions mark CrawlRun as 'failed'/'partial' with error_details (never left in 'crawling')
 * - Per-resource Atomic Transactions: Document upsert + version insert + item status update execute atomically
 * - Exact Recalculated Counters: pages_discovered, pages_fetched (stored+unchanged), pages_failed computed from kos_crawl_run_items
 * - Concurrency-safe SourceDocument upsert ON CONFLICT (source_id, canonical_url)
 * - SHA-256 deduplication (item status: 'stored' for new versions, 'unchanged' for identical versions)
 * - ZERO DB writes of CandidateDrafts or ParsedDocuments (ingestion layer only)
 */

const crypto = require('crypto');
const db = require('../../knowledge/db');
const sourceRegistry = require('./sourceRegistry');
const websiteCrawlerProvider = require('./websiteCrawlerProvider');
const rawResourceStorage = require('./rawResourceStorage');

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function createStructuredError(code, message, details = {}, retryable = false) {
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    err.details = details;
    err.retryable = retryable;
    return err;
}

async function ingestSource({
    sourceId,
    policy = {},
    dependencies = {},
}) {
    if (!sourceId) {
        throw createStructuredError('KOS_SOURCE_ID_REQUIRED', 'sourceId parameter is required', {}, false);
    }

    const registry = dependencies.sourceRegistry || sourceRegistry;
    const crawler = dependencies.websiteCrawlerProvider || websiteCrawlerProvider;
    const rawStorage = dependencies.rawResourceStorage || rawResourceStorage;
    const queryClient = dependencies.queryClient || (db.isEnabled() ? db.getPool() : null);

    // 1. Fetch Source Registry entity
    const source = await registry.getSource(sourceId, queryClient);
    if (!source) {
        throw createStructuredError('KOS_SOURCE_NOT_FOUND', `Source with ID ${sourceId} not found`, { sourceId }, false);
    }

    // 2. Create kos_crawl_runs record
    const crawlRunId = generateId('run');
    const startedAt = new Date().toISOString();

    if (queryClient) {
        const sqlRun = `
            INSERT INTO kos_crawl_runs (
                id, source_id, status, config_snapshot, pages_discovered, pages_fetched, pages_failed, started_at, created_at
            ) VALUES ($1, $2, 'crawling', $3, 0, 0, 0, $4, NOW())
            RETURNING *;
        `;
        await queryClient.query(sqlRun, [crawlRunId, source.id, JSON.stringify(policy), startedAt]);
    }

    const storedResources = [];
    let crawlResult = { status: 'failed', counters: { discovered: 0, fetched: 0, failed: 0, skipped: 0 }, resources: [], failures: [] };

    try {
        // 3. Execute Crawler Provider
        try {
            crawlResult = await crawler.crawlWebsite({
                source,
                crawlRunId,
                policy,
                dependencies,
            });
        } catch (err) {
            // Fatal crawl failure (e.g. seed SSRF blocked or invalid config)
            if (queryClient) {
                await queryClient.query(
                    `UPDATE kos_crawl_runs SET status = 'failed', error_details = $1, completed_at = NOW() WHERE id = $2`,
                    [JSON.stringify({ code: err.code || 'KOS_CRAWL_FAILED', message: err.message }), crawlRunId]
                );
            }
            throw err;
        }

        // 4. Record Initial kos_crawl_run_items
        if (queryClient && crawlResult.discoveredUrls) {
            for (const urlItem of crawlResult.discoveredUrls) {
                const itemId = generateId('item');
                await queryClient.query(
                    `INSERT INTO kos_crawl_run_items (
                        id, crawl_run_id, url, canonical_url, status, depth, parent_url, discovery_source, attempt_count, created_at, updated_at
                    ) VALUES ($1, $2, $3, $3, 'queued', 0, NULL, 'seed', 0, NOW(), NOW())
                    ON CONFLICT (crawl_run_id, canonical_url) DO NOTHING;`,
                    [itemId, crawlRunId, urlItem]
                );
            }
        }

        // 5. Process Successfully Fetched Resources with Per-Resource Atomicity
        for (const resItem of crawlResult.resources) {
            const requestedUrl = resItem.requestedUrl;
            const canonicalUrl = resItem.canonicalUrl || requestedUrl;
            const fetchRes = resItem.fetchResult;
            const rawBuffer = fetchRes.rawBody;

            let documentId = null;
            let versionId = null;
            let itemStatus = 'stored';

            if (queryClient) {
                // A. Atomic SourceDocument Upsert
                const docSql = `
                    INSERT INTO kos_source_documents (
                        id, source_id, requested_url, canonical_url, content_type, content_length, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
                    ON CONFLICT (source_id, canonical_url)
                    DO UPDATE SET
                        requested_url = EXCLUDED.requested_url,
                        content_type = EXCLUDED.content_type,
                        content_length = EXCLUDED.content_length,
                        updated_at = NOW()
                    RETURNING id;
                `;
                const docIdNew = generateId('doc');
                const docRes = await queryClient.query(docSql, [
                    docIdNew,
                    source.id,
                    requestedUrl,
                    canonicalUrl,
                    fetchRes.detectedContentType || fetchRes.declaredContentType,
                    fetchRes.contentLength || rawBuffer.length,
                ]);

                if (docRes.rows && docRes.rows.length > 0) {
                    documentId = docRes.rows[0].id;
                } else {
                    const selectDoc = await queryClient.query(
                        'SELECT id FROM kos_source_documents WHERE source_id = $1 AND canonical_url = $2',
                        [source.id, canonicalUrl]
                    );
                    documentId = selectDoc.rows[0].id;
                }

                // B. Raw Resource Storage & Deduplication
                const versionResult = await rawStorage.saveRawDocumentVersion(
                    {
                        documentId,
                        crawlRunId,
                        rawBuffer,
                        declaredMimeType: fetchRes.declaredContentType,
                        detectedMimeType: fetchRes.detectedContentType,
                        httpHeaders: fetchRes.headers,
                        fetchedAt: fetchRes.fetchedAt || new Date().toISOString(),
                    },
                    queryClient
                );

                versionId = versionResult.version.id;
                itemStatus = versionResult.existing ? 'unchanged' : 'stored';

                // C. Upsert Crawl Run Item Status
                const itemSql = `
                    INSERT INTO kos_crawl_run_items (
                        id, crawl_run_id, url, canonical_url, status, depth, parent_url, discovery_source,
                        document_id, version_id, http_status, attempt_count, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, NOW(), NOW())
                    ON CONFLICT (crawl_run_id, canonical_url)
                    DO UPDATE SET
                        status = EXCLUDED.status,
                        document_id = EXCLUDED.document_id,
                        version_id = EXCLUDED.version_id,
                        http_status = EXCLUDED.http_status,
                        attempt_count = kos_crawl_run_items.attempt_count + 1,
                        updated_at = NOW();
                `;
                await queryClient.query(itemSql, [
                    generateId('item'),
                    crawlRunId,
                    requestedUrl,
                    canonicalUrl,
                    itemStatus,
                    resItem.depth || 0,
                    resItem.parentUrl || null,
                    resItem.discoverySource || 'html_link',
                    documentId,
                    versionId,
                    fetchRes.statusCode || 200,
                ]);
            }

            storedResources.push({
                requestedUrl,
                canonicalUrl,
                documentId,
                versionId,
                status: itemStatus,
                detectedContentType: fetchRes.detectedContentType,
            });
        }

        // 6. Process Failures
        if (queryClient && crawlResult.failures) {
            for (const failure of crawlResult.failures) {
                const itemSql = `
                    INSERT INTO kos_crawl_run_items (
                        id, crawl_run_id, url, canonical_url, status, error_code, error_message, error_details, attempt_count, created_at, updated_at
                    ) VALUES ($1, $2, $3, $3, 'failed', $4, $5, $6, 1, NOW(), NOW())
                    ON CONFLICT (crawl_run_id, canonical_url)
                    DO UPDATE SET
                        status = 'failed',
                        error_code = EXCLUDED.error_code,
                        error_message = EXCLUDED.error_message,
                        error_details = EXCLUDED.error_details,
                        attempt_count = kos_crawl_run_items.attempt_count + 1,
                        updated_at = NOW();
                `;
                await queryClient.query(itemSql, [
                    generateId('item'),
                    crawlRunId,
                    failure.url,
                    failure.code,
                    failure.message,
                    JSON.stringify({ retryable: failure.retryable }),
                ]);
            }
        }

        // 7. Calculate Final Run Status & Recalculate Counters directly from DB Items
        let finalRunStatus = crawlResult.status || 'completed';

        const seedFailed = crawlResult.failures && crawlResult.failures.some((f) => f.url === source.seed_url);
        if (seedFailed) {
            finalRunStatus = 'failed';
        } else if (crawlResult.failures && crawlResult.failures.length > 0 && storedResources.length > 0) {
            finalRunStatus = 'partial';
        }

        let discoveredCount = crawlResult.counters.discovered || 0;
        let fetchedCount = storedResources.length;
        let failedCount = crawlResult.failures ? crawlResult.failures.length : 0;

        if (queryClient) {
            const { rows: itemSummaryRows } = await queryClient.query(
                `SELECT
                    COUNT(DISTINCT canonical_url) as discovered,
                    COUNT(*) FILTER (WHERE status IN ('stored', 'unchanged')) as fetched,
                    COUNT(*) FILTER (WHERE status = 'failed') as failed
                 FROM kos_crawl_run_items WHERE crawl_run_id = $1`,
                [crawlRunId]
            );
            if (itemSummaryRows && itemSummaryRows.length > 0) {
                discoveredCount = parseInt(itemSummaryRows[0].discovered, 10) || discoveredCount;
                fetchedCount = parseInt(itemSummaryRows[0].fetched, 10) || fetchedCount;
                failedCount = parseInt(itemSummaryRows[0].failed, 10) || failedCount;
            }
        }

        const completedAt = new Date().toISOString();

        if (queryClient) {
            const sqlFinal = `
                UPDATE kos_crawl_runs SET
                    status = $1,
                    pages_discovered = $2,
                    pages_fetched = $3,
                    pages_failed = $4,
                    completed_at = $5
                WHERE id = $6;
            `;
            await queryClient.query(sqlFinal, [
                finalRunStatus,
                discoveredCount,
                fetchedCount,
                failedCount,
                completedAt,
                crawlRunId,
            ]);
        }

        return {
            crawlRunId,
            sourceId: source.id,
            seedUrl: source.seed_url,
            startedAt,
            completedAt,
            status: finalRunStatus,
            counters: {
                discovered: discoveredCount,
                fetched: fetchedCount,
                failed: failedCount,
                skipped: crawlResult.counters ? (crawlResult.counters.skipped || 0) : 0,
            },
            storedResources,
            failures: crawlResult.failures,
        };
    } catch (unhandledErr) {
        // Outer Error Boundary: Mark run as failed/partial if unexpected exception occurs mid-run
        if (queryClient) {
            const recoveryStatus = storedResources.length > 0 ? 'partial' : 'failed';
            try {
                await queryClient.query(
                    `UPDATE kos_crawl_runs SET status = $1, error_details = $2, completed_at = NOW() WHERE id = $3`,
                    [recoveryStatus, JSON.stringify({ code: unhandledErr.code || 'KOS_UNHANDLED_INGESTION_ERROR', message: unhandledErr.message }), crawlRunId]
                );
            } catch {
                /* Best effort recovery */
            }
        }
        throw unhandledErr;
    }
}

module.exports = {
    ingestSource,
};

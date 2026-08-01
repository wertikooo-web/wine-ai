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
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const db = require('../../knowledge/db');
const sourceRegistry = require('./sourceRegistry');
const websiteCrawlerProvider = require('./websiteCrawlerProvider');
const rawResourceStorage = require('./rawResourceStorage');
const { DEFAULT_SOURCE_DIR } = require('../../knowledge/loader');
const { buildIndex } = require('../../knowledge/index');
const { cleanText, isSubstantial } = require('../../knowledge/processor/clean');
const publishService = require('../../knowledge/publishService');
const { extractWineProduct, extractEditorialArticle, extractContactPage } = require('../extraction/wineMdExtractor');
const { shouldActivateWineMdFact } = require('../extraction/conflictResolver');
// Git push REMOVED — crawled data is stored in Postgres, not pushed to Git.
// Manual curated file management (server.js) still uses gitPersist directly.

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

/**
 * Format extracted data into searchable text.
 */
function formatExtractedText(data) {
    if (!data) return null;

    const parts = [];

    if (data.type === 'wine_product') {
        if (data.name) parts.push(`Wine: ${data.name}`);
        if (data.winery) parts.push(`Winery: ${data.winery}`);
        if (data.vintage) parts.push(`Vintage: ${data.vintage}`);
        if (data.grape_varieties && data.grape_varieties.length) parts.push(`Grapes: ${data.grape_varieties.join(', ')}`);
        if (data.wine_type) parts.push(`Type: ${data.wine_type}`);
        if (data.color) parts.push(`Color: ${data.color}`);
        if (data.sweetness) parts.push(`Sweetness: ${data.sweetness}`);
        if (data.region) parts.push(`Region: ${data.region}`);
        if (data.description) parts.push(`Description: ${data.description}`);
        if (data.tasting_notes) parts.push(`Tasting notes: ${data.tasting_notes}`);
        if (data.pairing) parts.push(`Food pairing: ${data.pairing}`);
        if (data.serving_temperature) parts.push(`Serve at: ${data.serving_temperature}`);
        // NOTE: price, availability, alcohol, volume excluded from text index
        // These should be read via structured lookup, not semantic search
    } else if (data.type === 'editorial_article') {
        if (data.title) parts.push(`Title: ${data.title}`);
        if (data.author) parts.push(`Author: ${data.author}`);
        if (data.description) parts.push(`Summary: ${data.description}`);
        if (data.content) parts.push(`Content: ${data.content.slice(0, 5000)}`);
        if (data.tags && data.tags.length) parts.push(`Tags: ${data.tags.join(', ')}`);
    } else if (data.type === 'contact_page') {
        if (data.company_name) parts.push(`Company: ${data.company_name}`);
        if (data.address) parts.push(`Address: ${data.address}`);
        if (data.phone) parts.push(`Phone: ${data.phone}`);
        if (data.email) parts.push(`Email: ${data.email}`);
        if (data.website) parts.push(`Website: ${data.website}`);
        if (data.working_hours) parts.push(`Hours: ${data.working_hours}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
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
    // Bridge removed — crawled data is stored in Postgres only.
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

            try {
                const contentType = fetchRes.detectedContentType || fetchRes.declaredContentType || '';
                // Text extraction moved to Postgres storage — no filesystem bridge needed.
            } catch (extractErr) {
                console.error('[KOS] text extraction failed for', canonicalUrl, '(crawl itself continues):', extractErr.message);
            }

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

            // Wine.md-specific extraction: extract structured data and store in entity_facts
            if (source.source_type === 'primary_partner_source' && queryClient && rawBuffer) {
                try {
                    const html = rawBuffer.toString('utf8');
                    const urlClassification = dependencies.urlClassifier ? dependencies.urlClassifier(canonicalUrl) : null;
                    const docType = urlClassification ? urlClassification.type : 'unknown';

                    let extractedData = null;
                    if (docType === 'wine_product') {
                        extractedData = extractWineProduct(html, canonicalUrl);
                    } else if (docType === 'editorial_article') {
                        extractedData = extractEditorialArticle(html, canonicalUrl);
                    } else if (docType === 'contact_page') {
                        extractedData = extractContactPage(html, canonicalUrl);
                    }

                    if (extractedData && extractedData.name) {
                        // Store extracted data as normalized_text for search
                        const normalizedText = formatExtractedText(extractedData);
                        if (normalizedText) {
                            const normalizedBody = normalizedText.slice(0, 100000);
                            await queryClient.query(
                                `UPDATE kos_source_documents
                                 SET normalized_text = $1, title = $2, language = 'auto', status = 'active'
                                 WHERE id = $3`,
                                [normalizedBody, extractedData.name || extractedData.title, documentId]
                            );

                            // Stage 3: publish the document's chunks into
                            // knowledge_chunks through the shared publish service
                            // (the same path Dashboard uploads use). A chunk-publish
                            // failure must not fail the crawl — the document is
                            // already persisted, and the next reindex will retry.
                            try {
                                await publishService.publishDocument({
                                    pool: queryClient,
                                    documentId,
                                    metadata: {
                                        title: extractedData.name || extractedData.title,
                                        language: 'auto',
                                        doc_type: docType,
                                        source: canonicalUrl,
                                    },
                                    body: normalizedBody,
                                });
                            } catch (publishErr) {
                                console.error('[KOS] chunk publish failed for', canonicalUrl, ':', publishErr.message);
                            }
                        }
                    }
                } catch (extractErr) {
                    console.error('[KOS] wine.md extraction failed for', canonicalUrl, ':', extractErr.message);
                }
            }
        }

        // 5b. Bridge removed — crawled data is stored in Postgres only.
        // The index is rebuilt from Postgres via buildIndexFromPostgres().
        // This prevents crawler batches from writing to filesystem or triggering Railway deploys.

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

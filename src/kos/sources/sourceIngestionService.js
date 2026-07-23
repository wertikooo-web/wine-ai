'use strict';

/**
 * WINE AI KOS - Source Ingestion Orchestration Service (Step 2E)
 * 
 * Orchestrates Dashboard website additions, duplicate protections,
 * and ingestion crawls via SourceRegistry and CrawlIngestionService.
 * 
 * Guarantees:
 * - One normalized URL origin per owner scope corresponds to one Source entity.
 * - Prevents parallel crawls if a crawl is already running for the source.
 * - Explicitly separates crawlStatus ('pending'|'running'|'completed'|'partial'|'failed')
 *   from reviewStatus ('pending_review').
 * - Raw resources remain in pending ingestion storage (zero writes to kos_knowledge_facts).
 */

const defaultDb = require('../../knowledge/db');
const defaultSourceRegistry = require('./sourceRegistry');
const defaultCrawlIngestionService = require('./crawlIngestionService');
const { validateUrlSsrf } = require('./ssrfProtection');

function createError(code, message, status = 400) {
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    err.statusCode = status;
    return err;
}

function mapCrawlStatusToUiStatus(internalStatus) {
    if (!internalStatus) return 'pending';
    if (internalStatus === 'crawling' || internalStatus === 'queued') return 'running';
    if (internalStatus === 'stored' || internalStatus === 'parsing' || internalStatus === 'extracting' || internalStatus === 'completed') return 'completed';
    if (internalStatus === 'partial') return 'partial';
    if (internalStatus === 'failed') return 'failed';
    return internalStatus;
}

async function getLatestCrawlRun(sourceId, queryClient) {
    if (!queryClient || !sourceId) return null;
    try {
        const sql = `
            SELECT * FROM kos_crawl_runs
            WHERE source_id = $1
            ORDER BY started_at DESC, created_at DESC
            LIMIT 1;
        `;
        const { rows } = await queryClient.query(sql, [sourceId]);
        return rows && rows.length > 0 ? rows[0] : null;
    } catch {
        return null;
    }
}

async function getSourceDocumentCounts(sourceId, queryClient) {
    if (!queryClient || !sourceId) return { documentsCreated: 0, versionsCreated: 0 };
    try {
        const docSql = `SELECT COUNT(*) as count FROM kos_source_documents WHERE source_id = $1`;
        const { rows: docRows } = await queryClient.query(docSql, [sourceId]);
        const documentsCreated = docRows && docRows[0] ? parseInt(docRows[0].count, 10) || 0 : 0;

        const verSql = `
            SELECT COUNT(*) as count FROM kos_source_document_versions v
            JOIN kos_source_documents d ON v.document_id = d.id
            WHERE d.source_id = $1
        `;
        const { rows: verRows } = await queryClient.query(verSql, [sourceId]);
        const versionsCreated = verRows && verRows[0] ? parseInt(verRows[0].count, 10) || 0 : 0;

        return { documentsCreated, versionsCreated };
    } catch {
        return { documentsCreated: 0, versionsCreated: 0 };
    }
}

/**
 * Adds a new website or reuses existing source by origin, and starts crawl ingestion.
 */
async function addWebsiteAndStartCrawl({
    url,
    wineryId = null,
    name = null,
    policy = {},
    dependencies = {},
}) {
    if (!url || typeof url !== 'string' || !url.trim()) {
        throw createError('KOS_INVALID_URL', 'URL parameter is required and must be a non-empty string', 400);
    }

    const trimmedUrl = url.trim();
    let ssrfResult;
    try {
        ssrfResult = await validateUrlSsrf(trimmedUrl);
    } catch (ssrfErr) {
        throw createError('KOS_INVALID_URL_SCHEME', ssrfErr.message || 'Invalid URL or unsupported scheme', 400);
    }

    const normalizedOrigin = ssrfResult.normalizedOrigin;
    const registry = dependencies.sourceRegistry || defaultSourceRegistry;
    const crawlService = dependencies.crawlIngestionService || defaultCrawlIngestionService;
    const queryClient = dependencies.queryClient || (defaultDb.isEnabled() ? defaultDb.getPool() : null);

    // 1. Find existing source by origin
    let source = await registry.findSourceByOrigin(normalizedOrigin, queryClient);

    if (source) {
        // Source exists -> Check if crawl is already running
        const latestRun = await getLatestCrawlRun(source.id, queryClient);
        if (latestRun && (latestRun.status === 'crawling' || latestRun.status === 'queued')) {
            const err = createError('KOS_CRAWL_ALREADY_RUNNING', `Crawl is already active for source ${source.id}`, 409);
            err.source = source;
            err.crawlRun = latestRun;
            throw err;
        }
    } else {
        // Source does not exist -> Create Source entity via SourceRegistry
        const sourceName = (name && name.trim()) ? name.trim() : new URL(trimmedUrl).hostname;
        source = await registry.createSource(
            {
                name: sourceName,
                seedUrl: trimmedUrl,
                sourceType: 'official_website',
                trustLevel: 'C',
                wineryId: wineryId || null,
            },
            queryClient
        );
    }

    // 2. Trigger Crawl Ingestion Service
    let crawlResult = null;
    let crawlError = null;

    try {
        crawlResult = await crawlService.ingestSource({
            sourceId: source.id,
            policy,
            dependencies: { ...dependencies, queryClient },
        });
    } catch (err) {
        crawlError = err;
    }

    const latestRunAfter = await getLatestCrawlRun(source.id, queryClient);
    const rawStatus = crawlResult ? crawlResult.status : (latestRunAfter ? latestRunAfter.status : (crawlError ? 'failed' : 'pending'));
    const uiCrawlStatus = mapCrawlStatusToUiStatus(rawStatus);

    return {
        source,
        crawlRun: crawlResult || latestRunAfter || null,
        crawlStatus: uiCrawlStatus,
        reviewStatus: 'pending_review',
        error: crawlError ? { code: crawlError.code || 'KOS_CRAWL_FAILED', message: crawlError.message } : null,
    };
}

/**
 * Re-triggers crawl ingestion for an existing Source ID.
 */
async function triggerCrawlForSource({
    sourceId,
    policy = {},
    dependencies = {},
}) {
    if (!sourceId) {
        throw createError('KOS_SOURCE_ID_REQUIRED', 'sourceId parameter is required', 400);
    }

    const registry = dependencies.sourceRegistry || defaultSourceRegistry;
    const crawlService = dependencies.crawlIngestionService || defaultCrawlIngestionService;
    const queryClient = dependencies.queryClient || (defaultDb.isEnabled() ? defaultDb.getPool() : null);

    const source = await registry.getSource(sourceId, queryClient);
    if (!source) {
        throw createError('KOS_SOURCE_NOT_FOUND', `Source with ID ${sourceId} not found`, 404);
    }

    // Check if crawl is already running
    const latestRun = await getLatestCrawlRun(sourceId, queryClient);
    if (latestRun && (latestRun.status === 'crawling' || latestRun.status === 'queued')) {
        const err = createError('KOS_CRAWL_ALREADY_RUNNING', `Crawl is already active for source ${sourceId}`, 409);
        err.source = source;
        err.crawlRun = latestRun;
        throw err;
    }

    let crawlResult = null;
    let crawlError = null;
    try {
        crawlResult = await crawlService.ingestSource({
            sourceId,
            policy,
            dependencies: { ...dependencies, queryClient },
        });
    } catch (err) {
        crawlError = err;
    }

    const latestRunAfter = await getLatestCrawlRun(sourceId, queryClient);
    const rawStatus = crawlResult ? crawlResult.status : (latestRunAfter ? latestRunAfter.status : (crawlError ? 'failed' : 'pending'));
    const uiCrawlStatus = mapCrawlStatusToUiStatus(rawStatus);

    return {
        source,
        crawlRun: crawlResult || latestRunAfter || null,
        crawlStatus: uiCrawlStatus,
        reviewStatus: 'pending_review',
        error: crawlError ? { code: crawlError.code || 'KOS_CRAWL_FAILED', message: crawlError.message } : null,
    };
}

/**
 * Lists all registered sources with their latest crawl run status and document counts.
 */
async function listSourcesWithStatus({ wineryId = null, dependencies = {} } = {}) {
    const registry = dependencies.sourceRegistry || defaultSourceRegistry;
    const queryClient = dependencies.queryClient || (defaultDb.isEnabled() ? defaultDb.getPool() : null);

    const rawSources = await registry.listSources({ wineryId }, queryClient);
    const resultSources = [];

    for (const src of rawSources) {
        const latestRun = await getLatestCrawlRun(src.id, queryClient);
        const { documentsCreated, versionsCreated } = await getSourceDocumentCounts(src.id, queryClient);

        const rawStatus = latestRun ? latestRun.status : 'pending';
        const uiCrawlStatus = mapCrawlStatusToUiStatus(rawStatus);

        let parsedError = null;
        if (latestRun && latestRun.error_details) {
            try {
                parsedError = typeof latestRun.error_details === 'string' ? JSON.parse(latestRun.error_details) : latestRun.error_details;
            } catch {
                parsedError = { message: String(latestRun.error_details) };
            }
        }

        resultSources.push({
            id: src.id,
            name: src.name,
            seed_url: src.seed_url,
            normalized_origin: src.normalized_origin,
            source_type: src.source_type,
            trust_level: src.trust_level,
            publisher: src.publisher,
            winery_id: src.winery_id,
            created_at: src.created_at,
            updated_at: src.updated_at,
            crawl_status: uiCrawlStatus,
            review_status: 'pending_review',
            last_crawl: latestRun ? {
                id: latestRun.id,
                status: uiCrawlStatus,
                internal_status: latestRun.status,
                started_at: latestRun.started_at,
                completed_at: latestRun.completed_at,
                pages_discovered: latestRun.pages_discovered || 0,
                pages_fetched: latestRun.pages_fetched || 0,
                pages_failed: latestRun.pages_failed || 0,
                documents_created: documentsCreated,
                versions_created: versionsCreated,
                error: parsedError ? parsedError.message || parsedError.code : null,
            } : null,
        });
    }

    return { ok: true, sources: resultSources };
}

/**
 * Gets single source details with latest crawl run status.
 */
async function getSourceWithStatus({ sourceId, dependencies = {} }) {
    if (!sourceId) {
        throw createError('KOS_SOURCE_ID_REQUIRED', 'sourceId parameter is required', 400);
    }

    const registry = dependencies.sourceRegistry || defaultSourceRegistry;
    const queryClient = dependencies.queryClient || (defaultDb.isEnabled() ? defaultDb.getPool() : null);

    const src = await registry.getSource(sourceId, queryClient);
    if (!src) {
        throw createError('KOS_SOURCE_NOT_FOUND', `Source with ID ${sourceId} not found`, 404);
    }

    const latestRun = await getLatestCrawlRun(src.id, queryClient);
    const { documentsCreated, versionsCreated } = await getSourceDocumentCounts(src.id, queryClient);

    const rawStatus = latestRun ? latestRun.status : 'pending';
    const uiCrawlStatus = mapCrawlStatusToUiStatus(rawStatus);

    let parsedError = null;
    if (latestRun && latestRun.error_details) {
        try {
            parsedError = typeof latestRun.error_details === 'string' ? JSON.parse(latestRun.error_details) : latestRun.error_details;
        } catch {
            parsedError = { message: String(latestRun.error_details) };
        }
    }

    return {
        ok: true,
        source: {
            id: src.id,
            name: src.name,
            seed_url: src.seed_url,
            normalized_origin: src.normalized_origin,
            source_type: src.source_type,
            trust_level: src.trust_level,
            publisher: src.publisher,
            winery_id: src.winery_id,
            created_at: src.created_at,
            updated_at: src.updated_at,
            crawl_status: uiCrawlStatus,
            review_status: 'pending_review',
            last_crawl: latestRun ? {
                id: latestRun.id,
                status: uiCrawlStatus,
                internal_status: latestRun.status,
                started_at: latestRun.started_at,
                completed_at: latestRun.completed_at,
                pages_discovered: latestRun.pages_discovered || 0,
                pages_fetched: latestRun.pages_fetched || 0,
                pages_failed: latestRun.pages_failed || 0,
                documents_created: documentsCreated,
                versions_created: versionsCreated,
                error: parsedError ? parsedError.message || parsedError.code : null,
            } : null,
        },
    };
}

module.exports = {
    addWebsiteAndStartCrawl,
    triggerCrawlForSource,
    listSourcesWithStatus,
    getSourceWithStatus,
    mapCrawlStatusToUiStatus,
};

'use strict';

/**
 * Crawl Resume Service — processes queued items from existing crawl runs.
 *
 * Guarantees:
 * - SKIP LOCKED for concurrent safety
 * - Idempotent: repeated runs don't create duplicates
 * - Status lifecycle: queued → fetching → stored/unchanged/failed/skipped
 * - Recovery from crashes: fetching items reset to queued on timeout
 * - No Git mutations
 */

const crypto = require('crypto');
const db = require('../../knowledge/db');

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_ITEMS_PER_RUN = 200;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_LOCK_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_RETRY_AFTER_MS = 60000; // 1 minute

function generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Resume a crawl run by processing queued items.
 *
 * @param {string} crawlRunId - The crawl run to resume
 * @param {object} options - Configuration options
 * @returns {Promise<object>} Results of the resume operation
 */
async function resumeCrawlRun(crawlRunId, options = {}) {
    const {
        batchSize = DEFAULT_BATCH_SIZE,
        maxItemsPerRun = DEFAULT_MAX_ITEMS_PER_RUN,
        concurrency = DEFAULT_CONCURRENCY,
        delayMs = DEFAULT_DELAY_MS,
        lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
        retryAfterMs = DEFAULT_RETRY_AFTER_MS,
        processItem, // async (item) => { status, documentId?, error? }
    } = options;

    if (!crawlRunId) throw new Error('crawlRunId is required');
    if (!processItem) throw new Error('processItem callback is required');

    const pool = db.getPool();
    if (!pool) throw new Error('Postgres not available');

    const startedAt = Date.now();
    const runId = generateId('resume');
    let processed = 0;
    let failed = 0;
    let skipped = 0;

    console.log(`[crawlResume] Starting resume for crawl_run=${crawlRunId}, batch=${batchSize}, max=${maxItemsPerRun}`);

    // 1. Recover stale fetching items (locked too long)
    const recovered = await recoverStaleFetchingItems(crawlRunId, lockTimeoutMs, pool);
    if (recovered > 0) {
        console.log(`[crawlResume] Recovered ${recovered} stale fetching items`);
    }

    // 2. Process batches
    while (processed < maxItemsPerRun) {
        const remaining = maxItemsPerRun - processed;
        const currentBatch = Math.min(batchSize, remaining);

        // 3. Fetch and lock next batch with SKIP LOCKED
        const items = await fetchAndLockItems(crawlRunId, currentBatch, pool);
        if (items.length === 0) {
            console.log(`[crawlResume] No more queued items for crawl_run=${crawlRunId}`);
            break;
        }

        // 4. Process items concurrently
        const results = await processBatch(items, processItem, concurrency, delayMs, pool);

        for (const result of results) {
            if (result.status === 'stored' || result.status === 'unchanged') {
                processed++;
            } else if (result.status === 'failed') {
                failed++;
                processed++;
            } else {
                skipped++;
            }
        }

        console.log(`[crawlResume] Batch complete: processed=${processed}, failed=${failed}, skipped=${skipped}`);
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(`[crawlResume] Resume complete for crawl_run=${crawlRunId}: processed=${processed}, failed=${failed}, skipped=${skipped}, elapsed=${elapsedMs}ms`);

    return {
        crawlRunId,
        processed,
        failed,
        skipped,
        elapsedMs,
    };
}

/**
 * Fetch and lock next batch of queued items using SKIP LOCKED.
 */
async function fetchAndLockItems(crawlRunId, batchSize, pool) {
    const lockId = generateId('lock');

    const sql = `
        UPDATE kos_crawl_run_items
        SET status = 'fetching',
            locked_by = $1,
            locked_at = NOW()
        WHERE id IN (
            SELECT id FROM kos_crawl_run_items
            WHERE crawl_run_id = $2
              AND status IN ('queued', 'failed')
              AND (retry_after IS NULL OR retry_after <= NOW())
            ORDER BY priority DESC, created_at ASC
            LIMIT $3
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id, canonical_url, url, attempt_count, priority;
    `;

    const { rows } = await pool.query(sql, [lockId, crawlRunId, batchSize]);
    return rows;
}

/**
 * Process a batch of items with bounded concurrency.
 */
async function processBatch(items, processItem, concurrency, delayMs, pool) {
    const results = [];
    const chunks = [];
    for (let i = 0; i < items.length; i += concurrency) {
        chunks.push(items.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
        const chunkResults = await Promise.all(
            chunk.map((item) => processSingleItem(item, processItem, pool))
        );
        results.push(...chunkResults);

        if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return results;
}

/**
 * Process a single item and update its status.
 */
async function processSingleItem(item, processItem, pool) {
    const startTime = Date.now();

    try {
        const result = await processItem(item);
        const elapsedMs = Date.now() - startTime;

        // Update item status
        const status = result.status || 'stored';
        const sql = `
            UPDATE kos_crawl_run_items
            SET status = $1,
                document_id = $2,
                locked_by = NULL,
                locked_at = NULL,
                updated_at = NOW()
            WHERE id = $3;
        `;
        await pool.query(sql, [status, result.documentId || null, item.id]);

        return {
            id: item.id,
            canonicalUrl: item.canonical_url,
            status,
            elapsedMs,
        };
    } catch (error) {
        const elapsedMs = Date.now() - startTime;
        const isRetryable = error.retryable !== false;
        const attemptCount = (item.attempt_count || 0) + 1;

        // Update item as failed with retry support
        const sql = `
            UPDATE kos_crawl_run_items
            SET status = 'failed',
                last_error = $1,
                attempt_count = $2,
                retry_after = $3,
                locked_by = NULL,
                locked_at = NULL,
                updated_at = NOW()
            WHERE id = $4;
        `;

        const retryAfter = isRetryable && attemptCount < 3
            ? new Date(Date.now() + DEFAULT_RETRY_AFTER_MS * attemptCount).toISOString()
            : null;

        await pool.query(sql, [error.message, attemptCount, retryAfter, item.id]);

        return {
            id: item.id,
            canonicalUrl: item.canonical_url,
            status: 'failed',
            error: error.message,
            elapsedMs,
        };
    }
}

/**
 * Recover items stuck in 'fetching' status (locked too long).
 */
async function recoverStaleFetchingItems(crawlRunId, lockTimeoutMs, pool) {
    const sql = `
        UPDATE kos_crawl_run_items
        SET status = 'queued',
            locked_by = NULL,
            locked_at = NULL
        WHERE crawl_run_id = $1
          AND status = 'fetching'
          AND locked_at < NOW() - INTERVAL '1 millisecond' * $2
        RETURNING id;
    `;

    const { rows } = await pool.query(sql, [crawlRunId, lockTimeoutMs]);
    return rows.length;
}

/**
 * Get resume status for a crawl run.
 */
async function getResumeStatus(crawlRunId, pool) {
    const sql = `
        SELECT
            status,
            COUNT(*) as count
        FROM kos_crawl_run_items
        WHERE crawl_run_id = $1
        GROUP BY status;
    `;

    const { rows } = await pool.query(sql, [crawlRunId]);
    const statusCounts = {};
    for (const row of rows) {
        statusCounts[row.status] = parseInt(row.count, 10);
    }

    return {
        crawlRunId,
        queued: statusCounts.queued || 0,
        fetching: statusCounts.fetching || 0,
        stored: statusCounts.stored || 0,
        unchanged: statusCounts.unchanged || 0,
        failed: statusCounts.failed || 0,
        skipped: statusCounts.skipped || 0,
        total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    };
}

module.exports = {
    resumeCrawlRun,
    fetchAndLockItems,
    recoverStaleFetchingItems,
    getResumeStatus,
    DEFAULT_BATCH_SIZE,
    DEFAULT_MAX_ITEMS_PER_RUN,
    DEFAULT_LOCK_TIMEOUT_MS,
};

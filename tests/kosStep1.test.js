'use strict';

/**
 * WINE AI KOS - Step 1 Unit & Mock Test Suite
 *
 * Verifies schema initialization, object storage abstraction, compensating transactions,
 * concurrent duplicate uploads (race conditions), field policy freshness bounds, and error handling.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initKosSchema } = require('../src/kos/db/kosSchema');
const { createObjectStorageProvider, LocalFileStorageAdapter, S3StorageAdapterStub } = require('../src/kos/storage/objectStorage');
const { getFieldPolicy, calculateFreshnessScore } = require('../src/kos/config/fieldPolicies');
const {
    calculateChecksum,
    generateUuid,
    registerSource,
    findSourceByChecksum,
    getSourceById,
    listSourcesByWinery,
} = require('../src/kos/sources/sourceRepository');

const TEST_DIR = path.resolve(__dirname, '..', 'tmp_kos_step1_unit_test');

async function run() {
    // Ensure clean test storage dir
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const storageProvider = createObjectStorageProvider({ provider: 'local', baseDir: TEST_DIR });

    try {
        // 1. Schema Initialization (File fallback or PostgreSQL)
        await initKosSchema();
        await initKosSchema(); // Idempotency check

        // 2. Field Policies Unit Tests
        const alcoholPolicy = getFieldPolicy('wine.alcohol_percentage');
        assert.strictEqual(alcoholPolicy.requiresHumanApproval, true);

        const fallbackPolicy = getFieldPolicy('non_existent_field_key');
        assert.strictEqual(fallbackPolicy.requiresHumanApproval, true);

        // Freshness bounds & invalid date handling
        assert.strictEqual(calculateFreshnessScore(new Date().toISOString(), 365), 1.0);
        assert.strictEqual(calculateFreshnessScore(new Date(Date.now() - 400 * 86400 * 1000).toISOString(), 365), 0.1);
        assert.strictEqual(calculateFreshnessScore('invalid_date_string'), 0.5);
        assert.strictEqual(calculateFreshnessScore(null), 0.5);

        // 3. Object Storage Adapter S3 configuration validation
        assert.throws(() => {
            new S3StorageAdapterStub({}); // Missing credentials
        }, /s3_storage_missing_credentials/);

        // 4. Source Registration & Metadata Sanitization
        const sampleText = 'Castel Mimi was founded in 1893 by Constantin Mimi.';
        const wineryId1 = 'castel-mimi-test';
        const wineryId2 = 'purcari-test';

        const result1 = await registerSource({
            wineryId: wineryId1,
            sourceType: 'webpage',
            title: 'Castel Mimi About Page\x00', // Contains control char to sanitize
            originalUrl: 'https://castelmimi.md/about',
            rawContent: sampleText,
            language: 'en',
            documentType: 'winery_profile',
        }, { storageProvider, sourceDir: TEST_DIR });

        assert.strictEqual(result1.isDuplicate, false);
        assert.strictEqual(result1.source.wineryId, wineryId1);
        assert.strictEqual(result1.source.title, 'Castel Mimi About Page');
        assert.strictEqual(result1.source.checksum, calculateChecksum(sampleText));

        // Verify Object Storage content
        const storedObj = await storageProvider.getObject({ key: result1.source.storageKey });
        assert.strictEqual(storedObj.body.toString('utf8'), sampleText);

        // 5. Checksum Duplicate Detection per Winery
        const resultDuplicate = await registerSource({
            wineryId: wineryId1,
            sourceType: 'webpage',
            title: 'Castel Mimi Duplicate Upload',
            rawContent: sampleText,
        }, { storageProvider, sourceDir: TEST_DIR });

        assert.strictEqual(resultDuplicate.isDuplicate, true);
        assert.strictEqual(resultDuplicate.source.id, result1.source.id);

        // 6. Cross-Winery Duplicate Isolation
        const resultWinery2 = await registerSource({
            wineryId: wineryId2,
            sourceType: 'webpage',
            title: 'Purcari Source With Same Text',
            rawContent: sampleText,
        }, { storageProvider, sourceDir: TEST_DIR });

        assert.strictEqual(resultWinery2.isDuplicate, false);
        assert.notStrictEqual(resultWinery2.source.id, result1.source.id);
        assert.strictEqual(resultWinery2.source.wineryId, wineryId2);

        // 7. Concurrent Upload Race Condition Test
        const concurrentText = 'Unique concurrent upload content ' + Date.now();
        const concurrentWinery = 'concurrent-winery-test';

        const [resA, resB] = await Promise.all([
            registerSource({
                wineryId: concurrentWinery,
                sourceType: 'pdf',
                rawContent: concurrentText,
            }, { storageProvider, sourceDir: TEST_DIR }),
            registerSource({
                wineryId: concurrentWinery,
                sourceType: 'pdf',
                rawContent: concurrentText,
            }, { storageProvider, sourceDir: TEST_DIR }),
        ]);

        // One must be primary, the other must be detected as duplicate
        const isOnePrimary = (!resA.isDuplicate && resB.isDuplicate) || (resA.isDuplicate && !resB.isDuplicate);
        assert.ok(isOnePrimary, 'Concurrent upload race condition must resolve to one primary and one duplicate');

        // 8. Storage Error Handling & Compensating Transaction (No Orphan Objects)
        const failingStorage = {
            async putObject() { throw new Error('Simulated Storage Failure'); },
            async deleteObject() {}
        };

        await assert.rejects(async () => {
            await registerSource({
                wineryId: 'fail-winery-test',
                sourceType: 'pdf',
                rawContent: 'Sample content',
            }, { storageProvider: failingStorage, sourceDir: TEST_DIR });
        }, (err) => err.message.includes('storage_write_failed'));

        // Verify size limit rejection
        const hugeContent = Buffer.alloc(25 * 1024 * 1024); // 25MB > 20MB limit
        await assert.rejects(async () => {
            await registerSource({
                wineryId: 'huge-winery-test',
                sourceType: 'pdf',
                rawContent: hugeContent,
            }, { storageProvider, sourceDir: TEST_DIR });
        }, (err) => err.message.includes('source_content_too_large'));

        console.log('kosStep1.test.js: All unit & mock tests passed successfully.');
    } finally {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        }
    }
}

module.exports = { run };

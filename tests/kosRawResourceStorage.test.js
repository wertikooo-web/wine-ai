'use strict';

/**
 * WINE AI KOS - Raw Resource Storage & Deduplication Test Suite (Step 2C.1)
 */

const assert = require('assert');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const objectStorage = require('../src/kos/storage/objectStorage');
const { saveRawDocumentVersion, computeSha256 } = require('../src/kos/sources/rawResourceStorage');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const pool = createMemoryPgPool();
    const rawHtml = '<html><body><h1>Wine of Moldova Ingestion</h1></body></html>';
    const checksum = computeSha256(Buffer.from(rawHtml, 'utf8'));
    const storedObjects = new Map();
    const originalPut = objectStorage.put;
    const originalExists = objectStorage.exists;
    let putCalls = 0;

    objectStorage.put = async (key, body) => {
        putCalls++;
        storedObjects.set(key, Buffer.from(body));
        return { key, provider: 'test' };
    };
    objectStorage.exists = async (key) => storedObjects.has(key);

    try {
        // 1. Save Raw Version (Initial Ingestion)
        const result1 = await saveRawDocumentVersion({
            documentId: 'doc_100',
            rawBuffer: rawHtml,
            declaredMimeType: 'text/html; charset=utf-8',
            detectedMimeType: 'text/html',
            httpHeaders: { 'content-type': 'text/html; charset=utf-8' },
        }, pool);

        assertEqual(result1.existing, false);
        assertOk(result1.version.id.startsWith('ver_'));
        assertEqual(result1.version.checksum_sha256, checksum);
        assertEqual(result1.version.storage_key, `raw/${checksum}.bin`);
        assertEqual(putCalls, 1);

        // 2. Re-ingest Identical Raw Bytes (Immutability & Deduplication Check)
        const result2 = await saveRawDocumentVersion({
            documentId: 'doc_100',
            rawBuffer: rawHtml, // Identical raw content!
            declaredMimeType: 'text/html; charset=utf-8',
            detectedMimeType: 'text/html',
        }, pool);

        assertEqual(result2.existing, true); // Deduplicated!
        assertEqual(result2.repaired, false);
        assertEqual(result2.version.id, result1.version.id);

        // 3. If DB metadata survived but the blob did not, re-ingestion repairs
        // the object without creating a duplicate immutable version.
        storedObjects.delete(result1.version.storage_key);
        const result3 = await saveRawDocumentVersion({
            documentId: 'doc_100',
            rawBuffer: rawHtml,
            declaredMimeType: 'text/html; charset=utf-8',
            detectedMimeType: 'text/html',
        }, pool);

        assertEqual(result3.existing, true);
        assertEqual(result3.repaired, true);
        assertEqual(result3.version.id, result1.version.id);
        assertEqual(putCalls, 2);
        assertOk(storedObjects.has(result1.version.storage_key));

        console.log(`kosRawResourceStorage.test.js: All ${assertions} assertions passed successfully!`);
        return { assertionCount: assertions };
    } finally {
        objectStorage.put = originalPut;
        objectStorage.exists = originalExists;
    }
}

module.exports = { run };

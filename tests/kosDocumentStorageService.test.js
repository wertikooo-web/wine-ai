'use strict';

const assert = require('assert');
const { listDocuments, safePublicUrl } = require('../src/kos/sources/documentStorageService');

async function run() {
    let assertionCount = 0;
    const queryCalls = [];
    const queryClient = {
        async query(sql, params) {
            queryCalls.push({ sql, params });
            if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: '2' }] };
            return {
                rows: [
                    {
                        id: 'doc_1', source_id: 'src_1', source_name: 'Aurelius', source_type: 'official_website',
                        seed_url: 'https://aurelius.md/ro/', requested_url: 'https://aurelius.md/ro/wines',
                        canonical_url: 'https://aurelius.md/ro/wines', content_type: 'text/html', version_id: 'ver_1',
                        storage_key: 'raw/abc.bin', size_bytes: '2048', detected_mime_type: 'text/html',
                        fetched_at: '2026-08-05T12:00:00.000Z', checksum_sha256: 'abc',
                    },
                    {
                        id: 'doc_2', source_id: 'src_1', source_name: 'Aurelius', source_type: 'official_website',
                        seed_url: 'https://aurelius.md/ro/', requested_url: 'javascript:alert(1)',
                        canonical_url: 'javascript:alert(1)', version_id: 'ver_2', storage_key: 'raw/missing.bin',
                        size_bytes: '512', detected_mime_type: 'text/html', fetched_at: '2026-08-05T11:00:00.000Z',
                    },
                ],
            };
        },
    };
    const storage = { async list(prefix) { assert.strictEqual(prefix, 'raw/'); assertionCount += 1; return [{ key: 'raw/abc.bin' }]; } };

    const result = await listDocuments({ sourceId: 'src_1', limit: 500, offset: -4 }, { queryClient, objectStorage: storage });
    assert.strictEqual(result.ok, true); assertionCount += 1;
    assert.strictEqual(result.pagination.total, 2); assertionCount += 1;
    assert.strictEqual(result.pagination.limit, 100); assertionCount += 1;
    assert.strictEqual(result.pagination.offset, 0); assertionCount += 1;
    assert.deepStrictEqual(queryCalls[0].params, ['src_1']); assertionCount += 1;
    assert.deepStrictEqual(queryCalls[1].params, ['src_1', 100, 0]); assertionCount += 1;
    assert.strictEqual(result.documents[0].storageStatus, 'available'); assertionCount += 1;
    assert.strictEqual(result.documents[0].objectExists, true); assertionCount += 1;
    assert.strictEqual(result.documents[0].sizeBytes, 2048); assertionCount += 1;
    assert.strictEqual(result.documents[1].storageStatus, 'missing'); assertionCount += 1;
    assert.strictEqual(result.documents[1].url, null); assertionCount += 1;
    assert.strictEqual(safePublicUrl('https://wine.md/path'), 'https://wine.md/path'); assertionCount += 1;
    assert.strictEqual(safePublicUrl('file:///etc/passwd'), null); assertionCount += 1;

    const unknown = await listDocuments({}, {
        queryClient: {
            async query(sql) {
                if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: '1' }] };
                return { rows: [{ id: 'doc_3', source_id: 'src_2', source_name: 'Cricova', version_id: 'ver_3', storage_key: 'raw/x.bin' }] };
            },
        },
        objectStorage: { async list() { throw new Error('s3 unavailable'); } },
    });
    assert.strictEqual(unknown.storageCheck.ok, false); assertionCount += 1;
    assert.strictEqual(unknown.documents[0].storageStatus, 'unknown'); assertionCount += 1;
    assert.strictEqual(unknown.documents[0].objectExists, null); assertionCount += 1;

    console.log('KOS document storage service tests passed');
    return { assertionCount };
}

module.exports = { run };

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

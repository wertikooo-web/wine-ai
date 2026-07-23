'use strict';

const assert = require('assert');
const {
    S3StorageAdapter,
    createObjectStorageProvider,
} = require('../src/kos/storage/objectStorage');

class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
class HeadObjectCommand { constructor(input) { this.input = input; } }
class ListObjectsV2Command { constructor(input) { this.input = input; } }
class S3Client { constructor(config) { this.config = config; } }

const fakeSdk = {
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    S3Client,
};

function notFound() {
    return Object.assign(new Error('not found'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
    });
}

class InMemoryS3Client {
    constructor() {
        this.objects = new Map();
        this.commands = [];
        this.failure = null;
    }

    async send(command) {
        this.commands.push(command);
        if (this.failure) throw this.failure;
        const { Bucket, Key } = command.input;

        if (command instanceof PutObjectCommand) {
            this.objects.set(`${Bucket}/${Key}`, {
                body: Buffer.from(command.input.Body),
                contentType: command.input.ContentType,
                metadata: command.input.Metadata,
                lastModified: new Date('2026-01-01T00:00:00.000Z'),
            });
            return { ETag: 'fake-etag' };
        }
        if (command instanceof GetObjectCommand) {
            const item = this.objects.get(`${Bucket}/${Key}`);
            if (!item) throw notFound();
            return {
                Body: item.body,
                ContentLength: item.body.length,
                ContentType: item.contentType,
                Metadata: item.metadata,
            };
        }
        if (command instanceof HeadObjectCommand) {
            if (!this.objects.has(`${Bucket}/${Key}`)) throw notFound();
            return {};
        }
        if (command instanceof DeleteObjectCommand) {
            this.objects.delete(`${Bucket}/${Key}`);
            return {};
        }
        if (command instanceof ListObjectsV2Command) {
            const keys = [...this.objects.keys()]
                .filter((itemKey) => itemKey.startsWith(`${Bucket}/${command.input.Prefix || ''}`))
                .sort();
            const start = command.input.ContinuationToken ? Number(command.input.ContinuationToken) : 0;
            const page = keys.slice(start, start + 1);
            const next = start + page.length;
            return {
                Contents: page.map((itemKey) => {
                    const item = this.objects.get(itemKey);
                    return {
                        Key: itemKey.slice(Bucket.length + 1),
                        Size: item.body.length,
                        LastModified: item.lastModified,
                        ETag: 'fake-etag',
                    };
                }),
                IsTruncated: next < keys.length,
                NextContinuationToken: next < keys.length ? String(next) : undefined,
            };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
    }
}

function createAdapter(client = new InMemoryS3Client(), overrides = {}) {
    return new S3StorageAdapter({
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-east-1',
        bucket: 'wine-ai-private',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        forcePathStyle: true,
        prefix: 'kos-test',
        client,
        sdk: fakeSdk,
        signUrl: async (_client, command, options) => (
            `https://signed.invalid/${command.input.Bucket}/${command.input.Key}?ttl=${options.expiresIn}`
        ),
        ...overrides,
    });
}

async function run() {
    const client = new InMemoryS3Client();
    const adapter = createAdapter(client);
    const body = Buffer.from('Feteasca Neagra');

    const saved = await adapter.putObject({
        key: 'raw/wine-1.txt',
        body,
        mimeType: 'text/plain',
        metadata: { wineryId: 42 },
    });
    assert.strictEqual(saved.provider, 's3');
    assert.strictEqual(saved.sizeBytes, body.length);
    assert.match(saved.checksum, /^[a-f0-9]{64}$/);
    assert.strictEqual(client.commands[0].input.ACL, undefined, 'adapter must not make objects public');
    assert.deepStrictEqual(client.commands[0].input.Metadata, { wineryId: '42' });
    assert.strictEqual(await adapter.exists({ key: 'raw/wine-1.txt' }), true);

    await adapter.put('raw/wine-2.txt', 'second object', { mimeType: 'text/plain' });
    const loaded = await adapter.get('raw/wine-1.txt');
    assert.strictEqual(loaded.body.toString('utf8'), 'Feteasca Neagra');
    assert.strictEqual(loaded.mimeType, 'text/plain');

    const listed = await adapter.list('raw/');
    assert.deepStrictEqual(listed.map((item) => item.key), ['raw/wine-1.txt', 'raw/wine-2.txt']);
    assert.ok(client.commands.filter((command) => command instanceof ListObjectsV2Command).length >= 2,
        'list must follow continuation tokens');

    const signedUrl = await adapter.getSignedUrl({ key: 'raw/wine-1.txt', expiresInSeconds: 90 });
    assert.strictEqual(signedUrl, 'https://signed.invalid/wine-ai-private/kos-test/raw/wine-1.txt?ttl=90');

    await adapter.delete('raw/wine-1.txt');
    assert.strictEqual(await adapter.exists({ key: 'raw/wine-1.txt' }), false);
    await assert.rejects(
        adapter.getObject({ key: 'raw/wine-1.txt' }),
        (error) => error.code === 'STORAGE_OBJECT_NOT_FOUND'
    );

    assert.throws(
        () => new S3StorageAdapter({ bucket: '', accessKeyId: '', secretAccessKey: '', sdk: fakeSdk }),
        (error) => error.code === 'S3_STORAGE_MISSING_CREDENTIALS'
    );
    assert.throws(
        () => createAdapter(new InMemoryS3Client(), { endpoint: 'ftp://invalid.example' }),
        (error) => error.code === 'S3_STORAGE_INVALID_CONFIG'
    );
    assert.throws(
        () => createAdapter(new InMemoryS3Client(), { signedUrlTtl: 0 }),
        (error) => error.code === 'S3_STORAGE_INVALID_CONFIG'
    );
    assert.throws(
        () => createAdapter(new InMemoryS3Client(), { forcePathStyle: 'sometimes' }),
        (error) => error.code === 'S3_STORAGE_INVALID_CONFIG'
    );

    const failingClient = new InMemoryS3Client();
    failingClient.failure = Object.assign(new Error('access denied'), { name: 'AccessDenied' });
    const failingAdapter = createAdapter(failingClient);
    await assert.rejects(
        failingAdapter.putObject({ key: 'raw/fail.txt', body: 'fail' }),
        (error) => error.code === 'S3_STORAGE_OPERATION_FAILED' && error.operation === 'putObject'
    );
    await assert.rejects(
        failingAdapter.exists({ key: 'raw/fail.txt' }),
        (error) => error.code === 'S3_STORAGE_OPERATION_FAILED' && error.operation === 'exists'
    );

    const factoryAdapter = createObjectStorageProvider({
        provider: 's3',
        bucket: 'wine-ai-private',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        client: new InMemoryS3Client(),
        sdk: fakeSdk,
        signUrl: async () => 'signed',
    });
    assert.ok(factoryAdapter instanceof S3StorageAdapter);

    console.log('kosS3Storage.test.js: S3-compatible adapter lifecycle and error tests passed.');
}

module.exports = { run };

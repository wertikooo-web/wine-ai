'use strict';

/**
 * WINE AI KOS - Object Storage Abstraction & Adapters
 * Supports S3-compatible cloud storage and Local Filesystem Adapter for local dev.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRUE_VALUES = /^(1|true|yes)$/i;
const MAX_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

function requiredKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) {
        throw Object.assign(new Error('storage_key_invalid: key must be a non-empty string without NUL bytes'), {
            code: 'STORAGE_KEY_INVALID',
        });
    }
    return key;
}

function bodyToBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    throw Object.assign(new Error('storage_body_invalid: body must be a string, Buffer, or Uint8Array'), {
        code: 'STORAGE_BODY_INVALID',
    });
}

function normalizeMetadata(metadata) {
    if (!metadata) return undefined;
    return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value)]));
}

class LocalFileStorageAdapter {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '..', '..', '..', 'knowledge', 'raw_objects');
    }

    _resolvePath(key) {
        requiredKey(key);
        // Safe key resolution - prevents path traversal and preserves the existing flat-file layout.
        const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this.baseDir, safeKey);
    }

    async putObject({ key, body, mimeType }) {
        fs.mkdirSync(this.baseDir, { recursive: true });
        const filePath = this._resolvePath(key);
        const buffer = bodyToBuffer(body);
        fs.writeFileSync(filePath, buffer);
        const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
        return {
            key,
            storagePath: filePath,
            sizeBytes: buffer.length,
            checksum,
            mimeType: mimeType || 'application/octet-stream',
            provider: 'local',
        };
    }

    async getObject({ key }) {
        const filePath = this._resolvePath(key);
        if (!fs.existsSync(filePath)) {
            throw new Error(`storage_object_not_found: ${key}`);
        }
        const buffer = fs.readFileSync(filePath);
        return {
            body: buffer,
            sizeBytes: buffer.length,
        };
    }

    async deleteObject({ key }) {
        const filePath = this._resolvePath(key);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return { ok: true };
    }

    async getSignedUrl({ key, expiresInSeconds = 3600 }) {
        requiredKey(key);
        return `/api/kos/sources/download/${encodeURIComponent(key)}`;
    }

    async exists({ key }) {
        const filePath = this._resolvePath(key);
        return fs.existsSync(filePath);
    }

    async listObjects({ prefix = '' } = {}) {
        if (!fs.existsSync(this.baseDir)) return [];
        const safePrefix = prefix.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return fs.readdirSync(this.baseDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.startsWith(safePrefix))
            .map((entry) => {
                const stat = fs.statSync(path.join(this.baseDir, entry.name));
                return {
                    key: prefix ? `${prefix}${entry.name.slice(safePrefix.length)}` : entry.name,
                    sizeBytes: stat.size,
                    lastModified: stat.mtime,
                };
            });
    }

    async put(key, body, options = {}) { return this.putObject({ key, body, ...options }); }
    async get(key) { return this.getObject({ key }); }
    async delete(key) { return this.deleteObject({ key }); }
    async list(prefix = '') { return this.listObjects({ prefix }); }
}

function parseBoolean(value, envName) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return false;
    if (TRUE_VALUES.test(String(value))) return true;
    if (/^(0|false|no)$/i.test(String(value))) return false;
    throw Object.assign(new Error(`s3_storage_invalid_config: ${envName} must be true or false`), {
        code: 'S3_STORAGE_INVALID_CONFIG',
    });
}

function normalizePrefix(prefix) {
    return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function isNotFoundError(error) {
    return error && (
        error.name === 'NoSuchKey'
        || error.name === 'NotFound'
        || error.Code === 'NoSuchKey'
        || error.$metadata?.httpStatusCode === 404
    );
}

async function streamToBuffer(body) {
    if (body === undefined || body === null) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body.transformToByteArray === 'function') {
        return Buffer.from(await body.transformToByteArray());
    }
    if (typeof body[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    }
    throw Object.assign(new Error('s3_storage_invalid_response: object body is not readable'), {
        code: 'S3_STORAGE_INVALID_RESPONSE',
    });
}

class S3StorageAdapter {
    constructor(config = {}) {
        this.config = {
            endpoint: config.endpoint ?? process.env.S3_ENDPOINT,
            region: config.region ?? process.env.S3_REGION ?? 'us-east-1',
            bucket: config.bucket ?? process.env.S3_BUCKET,
            accessKeyId: config.accessKeyId ?? process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: config.secretAccessKey ?? process.env.S3_SECRET_ACCESS_KEY,
            sessionToken: config.sessionToken ?? process.env.S3_SESSION_TOKEN,
            forcePathStyle: parseBoolean(
                config.forcePathStyle ?? process.env.S3_FORCE_PATH_STYLE,
                'S3_FORCE_PATH_STYLE'
            ),
            prefix: normalizePrefix(config.prefix ?? process.env.S3_OBJECT_PREFIX),
            signedUrlTtl: Number(config.signedUrlTtl ?? process.env.S3_SIGNED_URL_TTL_SECONDS ?? 3600),
        };

        this._validateConfig();
        const sdk = config.sdk || require('@aws-sdk/client-s3');
        this.commands = sdk;
        this.client = config.client || new sdk.S3Client(this._clientConfig());
        this.signUrl = config.signUrl || require('@aws-sdk/s3-request-presigner').getSignedUrl;
    }

    _validateConfig() {
        const missing = [];
        if (!this.config.bucket) missing.push('S3_BUCKET');
        if (!this.config.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
        if (!this.config.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
        if (missing.length > 0) {
            throw Object.assign(
                new Error(`s3_storage_missing_credentials: The following S3 configuration environment variables are missing: ${missing.join(', ')}`),
                { code: 'S3_STORAGE_MISSING_CREDENTIALS' }
            );
        }

        if (!this.config.region || typeof this.config.region !== 'string') {
            throw Object.assign(new Error('s3_storage_invalid_config: S3_REGION must be a non-empty string'), {
                code: 'S3_STORAGE_INVALID_CONFIG',
            });
        }
        if (this.config.endpoint) {
            let endpoint;
            try { endpoint = new URL(this.config.endpoint); } catch { endpoint = null; }
            if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol)) {
                throw Object.assign(new Error('s3_storage_invalid_config: S3_ENDPOINT must be an http(s) URL'), {
                    code: 'S3_STORAGE_INVALID_CONFIG',
                });
            }
        }
        if (!Number.isInteger(this.config.signedUrlTtl)
            || this.config.signedUrlTtl < 1
            || this.config.signedUrlTtl > MAX_SIGNED_URL_TTL_SECONDS) {
            throw Object.assign(
                new Error(`s3_storage_invalid_config: S3_SIGNED_URL_TTL_SECONDS must be an integer between 1 and ${MAX_SIGNED_URL_TTL_SECONDS}`),
                { code: 'S3_STORAGE_INVALID_CONFIG' }
            );
        }
    }

    _clientConfig() {
        const clientConfig = {
            region: this.config.region,
            forcePathStyle: this.config.forcePathStyle,
            credentials: {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey,
                ...(this.config.sessionToken ? { sessionToken: this.config.sessionToken } : {}),
            },
        };
        if (this.config.endpoint) clientConfig.endpoint = this.config.endpoint;
        return clientConfig;
    }

    _key(key) {
        const normalizedKey = requiredKey(key).replace(/^\/+/, '');
        return this.config.prefix ? `${this.config.prefix}/${normalizedKey}` : normalizedKey;
    }

    _publicKey(storageKey) {
        const prefix = this.config.prefix ? `${this.config.prefix}/` : '';
        return prefix && storageKey.startsWith(prefix) ? storageKey.slice(prefix.length) : storageKey;
    }

    _operationError(operation, key, error) {
        if (isNotFoundError(error)) {
            return Object.assign(new Error(`storage_object_not_found: ${key}`), {
                code: 'STORAGE_OBJECT_NOT_FOUND',
                operation,
                cause: error,
            });
        }
        return Object.assign(new Error(`s3_storage_operation_failed: ${operation} failed for "${key}": ${error.message}`), {
            code: 'S3_STORAGE_OPERATION_FAILED',
            operation,
            cause: error,
        });
    }

    async putObject({ key, body, mimeType, metadata }) {
        const buffer = bodyToBuffer(body);
        const storageKey = this._key(key);
        try {
            await this.client.send(new this.commands.PutObjectCommand({
                Bucket: this.config.bucket,
                Key: storageKey,
                Body: buffer,
                ContentType: mimeType || 'application/octet-stream',
                Metadata: normalizeMetadata(metadata),
            }));
        } catch (error) {
            throw this._operationError('putObject', key, error);
        }
        return {
            key,
            storagePath: `s3://${this.config.bucket}/${storageKey}`,
            sizeBytes: buffer.length,
            checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
            mimeType: mimeType || 'application/octet-stream',
            provider: 's3',
        };
    }

    async getObject({ key }) {
        try {
            const response = await this.client.send(new this.commands.GetObjectCommand({
                Bucket: this.config.bucket,
                Key: this._key(key),
            }));
            const body = await streamToBuffer(response.Body);
            return {
                body,
                sizeBytes: response.ContentLength ?? body.length,
                mimeType: response.ContentType,
                metadata: response.Metadata || {},
            };
        } catch (error) {
            if (error.code === 'S3_STORAGE_INVALID_RESPONSE') throw error;
            throw this._operationError('getObject', key, error);
        }
    }

    async deleteObject({ key }) {
        try {
            await this.client.send(new this.commands.DeleteObjectCommand({
                Bucket: this.config.bucket,
                Key: this._key(key),
            }));
            return { ok: true };
        } catch (error) {
            throw this._operationError('deleteObject', key, error);
        }
    }

    async getSignedUrl({ key, expiresInSeconds = this.config.signedUrlTtl }) {
        const ttl = Number(expiresInSeconds);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_TTL_SECONDS) {
            throw Object.assign(new Error(`s3_storage_invalid_config: signed URL TTL must be between 1 and ${MAX_SIGNED_URL_TTL_SECONDS}`), {
                code: 'S3_STORAGE_INVALID_CONFIG',
            });
        }
        try {
            return await this.signUrl(
                this.client,
                new this.commands.GetObjectCommand({ Bucket: this.config.bucket, Key: this._key(key) }),
                { expiresIn: ttl }
            );
        } catch (error) {
            throw this._operationError('getSignedUrl', key, error);
        }
    }

    async exists({ key }) {
        try {
            await this.client.send(new this.commands.HeadObjectCommand({
                Bucket: this.config.bucket,
                Key: this._key(key),
            }));
            return true;
        } catch (error) {
            if (isNotFoundError(error)) return false;
            throw this._operationError('exists', key, error);
        }
    }

    async listObjects({ prefix = '' } = {}) {
        const results = [];
        let continuationToken;
        const normalizedPrefix = String(prefix).replace(/^\/+/, '');
        const storagePrefix = this.config.prefix
            ? `${this.config.prefix}/${normalizedPrefix}`
            : normalizedPrefix;
        do {
            let response;
            try {
                response = await this.client.send(new this.commands.ListObjectsV2Command({
                    Bucket: this.config.bucket,
                    Prefix: storagePrefix,
                    ContinuationToken: continuationToken,
                }));
            } catch (error) {
                throw this._operationError('listObjects', prefix, error);
            }
            for (const item of response.Contents || []) {
                if (typeof item.Key !== 'string') continue;
                results.push({
                    key: this._publicKey(item.Key),
                    sizeBytes: item.Size,
                    lastModified: item.LastModified,
                    etag: item.ETag,
                });
            }
            continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        } while (continuationToken);
        return results;
    }

    async put(key, body, options = {}) { return this.putObject({ key, body, ...options }); }
    async get(key) { return this.getObject({ key }); }
    async delete(key) { return this.deleteObject({ key }); }
    async list(prefix = '') { return this.listObjects({ prefix }); }
}

function createObjectStorageProvider(options = {}) {
    const providerType = options.provider || process.env.KOS_STORAGE_PROVIDER || 'local';
    const isProduction = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV === 'production');

    if (providerType === 'local') {
        if (isProduction && !options.allowLocalInProd && !TRUE_VALUES.test(process.env.KOS_ALLOW_LOCAL_PROD || '')) {
            throw new Error(
                'KOS_STORAGE_DISABLED_IN_PROD: Cannot use local filesystem object storage in production environment (Railway). ' +
                'Configure persistent S3 storage (KOS_STORAGE_PROVIDER=s3) or set KOS_ALLOW_LOCAL_PROD=true for testing.'
            );
        }
        return new LocalFileStorageAdapter(options.baseDir);
    }

    if (providerType === 's3') {
        return new S3StorageAdapter(options);
    }

    throw new Error(`unsupported_storage_provider: Unknown provider "${providerType}"`);
}

let defaultProvider;
function getDefaultProvider() {
    if (!defaultProvider) defaultProvider = createObjectStorageProvider();
    return defaultProvider;
}

module.exports = {
    createObjectStorageProvider,
    LocalFileStorageAdapter,
    S3StorageAdapter,
    put: (key, body, options) => getDefaultProvider().put(key, body, options),
    get: (key) => getDefaultProvider().get(key),
    delete: (key) => getDefaultProvider().delete(key),
    list: (prefix) => getDefaultProvider().list(prefix),
    exists: (key) => getDefaultProvider().exists({ key }),
};

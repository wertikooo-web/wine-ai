'use strict';

/**
 * WINE AI KOS - Object Storage Abstraction & Adapters
 * Supports S3-compatible cloud storage and Local Filesystem Adapter for local dev.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LocalFileStorageAdapter {
    constructor(baseDir) {
        this.baseDir = baseDir || path.resolve(__dirname, '..', '..', '..', 'knowledge', 'raw_objects');
    }

    _resolvePath(key) {
        // Safe key resolution - prevents path traversal
        const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this.baseDir, safeKey);
    }

    async putObject({ key, body, mimeType }) {
        fs.mkdirSync(this.baseDir, { recursive: true });
        const filePath = this._resolvePath(key);
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
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
        return `/api/kos/sources/download/${encodeURIComponent(key)}`;
    }

    async exists({ key }) {
        const filePath = this._resolvePath(key);
        return fs.existsSync(filePath);
    }
}

class S3StorageAdapterStub {
    constructor(config) {
        this.config = {
            endpoint: config.endpoint || process.env.S3_ENDPOINT,
            region: config.region || process.env.S3_REGION || 'us-east-1',
            bucket: config.bucket || process.env.S3_BUCKET,
            accessKeyId: config.accessKeyId || process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: config.secretAccessKey || process.env.S3_SECRET_ACCESS_KEY,
            forcePathStyle: config.forcePathStyle || /^(1|true|yes)$/i.test(process.env.S3_FORCE_PATH_STYLE || ''),
            prefix: config.prefix || process.env.S3_OBJECT_PREFIX || '',
            signedUrlTtl: Number(config.signedUrlTtl || process.env.S3_SIGNED_URL_TTL_SECONDS || 3600),
        };

        this._validateConfig();
    }

    _validateConfig() {
        const missing = [];
        if (!this.config.bucket) missing.push('S3_BUCKET');
        if (!this.config.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
        if (!this.config.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');

        if (missing.length > 0) {
            throw new Error(`s3_storage_missing_credentials: The following S3 configuration environment variables are missing: ${missing.join(', ')}`);
        }
    }

    async putObject({ key, body, mimeType }) {
        throw new Error('S3StorageAdapterStub: AWS SDK integration pending. S3 credentials verified but S3 HTTP client is not yet attached.');
    }

    async getObject({ key }) {
        throw new Error('S3StorageAdapterStub: AWS SDK integration pending.');
    }

    async deleteObject({ key }) {
        throw new Error('S3StorageAdapterStub: AWS SDK integration pending.');
    }

    async getSignedUrl({ key }) {
        throw new Error('S3StorageAdapterStub: AWS SDK integration pending.');
    }

    async exists({ key }) {
        throw new Error('S3StorageAdapterStub: AWS SDK integration pending.');
    }
}

function createObjectStorageProvider(options = {}) {
    const providerType = options.provider || process.env.KOS_STORAGE_PROVIDER || 'local';
    const isProduction = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV === 'production');

    if (providerType === 'local') {
        if (isProduction && !options.allowLocalInProd && !/^(1|true|yes)$/i.test(process.env.KOS_ALLOW_LOCAL_PROD || '')) {
            throw new Error(
                'KOS_STORAGE_DISABLED_IN_PROD: Cannot use local filesystem object storage in production environment (Railway). ' +
                'Configure persistent S3 storage (KOS_STORAGE_PROVIDER=s3) or set KOS_ALLOW_LOCAL_PROD=true for testing.'
            );
        }
        return new LocalFileStorageAdapter(options.baseDir);
    }

    if (providerType === 's3') {
        throw new Error(
            'KOS_S3_NOT_IMPLEMENTED: Production AWS S3 object storage adapter is not yet implemented. ' +
            'Only local development storage (KOS_STORAGE_PROVIDER=local) is supported at this stage.'
        );
    }

    throw new Error(`unsupported_storage_provider: Unknown provider "${providerType}"`);
}

module.exports = {
    createObjectStorageProvider,
    LocalFileStorageAdapter,
    S3StorageAdapterStub,
};

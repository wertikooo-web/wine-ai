'use strict';

/**
 * WINE AI KOS - Document Parsing Service (Step 2C.4)
 *
 * Orchestrates raw document parsing into a normalized ParsedDocument:
 * 1. Checks Idempotency: Returns existing ParsedDocument if (version_id, adapter_name, adapter_version) exists.
 * 2. Reads raw blob from ObjectStorage.
 * 3. Verifies SHA-256(raw blob) === version.checksum_sha256. Throws KOS_RAW_CHECKSUM_MISMATCH if mismatched.
 * 4. Resolves FormatAdapter via detected MIME type.
 * 5. Parses raw blob into blocks -> builds ParsedDocument with verified character offsets.
 * 6. Executes short DB Transaction: INSERT ON CONFLICT (version_id, adapter_name, adapter_version) DO NOTHING -> COMMIT.
 */

const crypto = require('crypto');
const db = require('../../knowledge/db');
const rawResourceStorage = require('../sources/rawResourceStorage');
const formatAdapterRegistry = require('./formatAdapterRegistry');
const parsedDocumentBuilder = require('./parsedDocumentBuilder');

async function parseDocumentVersion({
    versionId,
    overrideAdapterVersion,
    policy = {},
    dependencies = {},
}) {
    if (!versionId) {
        throw Object.assign(new Error('KOS_VERSION_ID_REQUIRED: versionId parameter is required'), { code: 'KOS_VERSION_ID_REQUIRED' });
    }

    const storage = dependencies.rawResourceStorage || rawResourceStorage;
    const registry = dependencies.formatAdapterRegistry || formatAdapterRegistry;
    const builder = dependencies.parsedDocumentBuilder || parsedDocumentBuilder;
    const queryClient = dependencies.queryClient || (db.isEnabled() ? db.getPool() : null);

    if (!queryClient) {
        throw Object.assign(new Error('KOS_QUERY_CLIENT_REQUIRED: Database client is required'), { code: 'KOS_QUERY_CLIENT_REQUIRED' });
    }

    // 1. Fetch SourceDocumentVersion from DB
    const versionRes = await queryClient.query(
        'SELECT * FROM kos_source_document_versions WHERE id = $1',
        [versionId]
    );

    if (!versionRes.rows || versionRes.rows.length === 0) {
        throw Object.assign(new Error(`KOS_VERSION_NOT_FOUND: Version ${versionId} not found`), { code: 'KOS_VERSION_NOT_FOUND', versionId });
    }

    const version = versionRes.rows[0];
    const mimeType = version.detected_mime_type || version.declared_mime_type;

    // 2. Resolve Format Adapter & Composite Parser Version
    const adapter = registry.getAdapterForMime(mimeType);
    const adapterName = adapter.ADAPTER_NAME;
    const builderVersion = builder.BUILDER_VERSION || '1.0.0';
    const adapterVersion = overrideAdapterVersion || `${adapter.ADAPTER_VERSION}+builder-${builderVersion}`;

    // 3. Idempotency Check
    const existingParsedRes = await queryClient.query(
        `SELECT * FROM kos_parsed_documents
         WHERE version_id = $1 AND adapter_name = $2 AND adapter_version = $3`,
        [version.id, adapterName, adapterVersion]
    );

    if (existingParsedRes.rows && existingParsedRes.rows.length > 0) {
        const row = existingParsedRes.rows[0];
        return {
            id: row.id,
            version_id: row.version_id,
            document_id: row.document_id,
            adapter_name: row.adapter_name,
            adapter_version: row.adapter_version,
            canonical_text: row.canonical_text,
            structural_units: typeof row.structural_units === 'string' ? JSON.parse(row.structural_units) : row.structural_units,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
            parsed_at: row.parsed_at,
            existing: true,
        };
    }

    // 4. Read Raw Blob from ObjectStorage
    const rawVersion = await storage.getRawDocumentVersion(version.id, queryClient);
    const rawBlob = rawVersion.rawBuffer;

    // 5. Verify Checksum SHA-256
    const actualChecksum = crypto.createHash('sha256').update(rawBlob).digest('hex');
    if (actualChecksum !== version.checksum_sha256) {
        throw Object.assign(
            new Error(`KOS_RAW_CHECKSUM_MISMATCH: Computed SHA-256 (${actualChecksum}) does not match expected (${version.checksum_sha256})`),
            { code: 'KOS_RAW_CHECKSUM_MISMATCH', expected: version.checksum_sha256, actual: actualChecksum }
        );
    }

    // 6. Parse Raw Blob (OUTSIDE of DB transaction)
    const parseResult = await adapter.parse({ rawBody: rawBlob, limits: policy });

    // 7. Build ParsedDocument with Offset Invariant Check
    const parsedDoc = builder.buildParsedDocument({
        documentVersionId: version.id,
        documentId: version.document_id,
        adapterName,
        adapterVersion,
        title: parseResult.title || '',
        blocks: parseResult.blocks || [],
        warnings: parseResult.warnings || [],
    });

    // 8. Short DB Transaction for Insert
    await queryClient.query('BEGIN');
    let finalDoc = parsedDoc;

    try {
        const insertSql = `
            INSERT INTO kos_parsed_documents (
                id, version_id, document_id, adapter_name, adapter_version, canonical_text, structural_units, metadata, parsed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (version_id, adapter_name, adapter_version)
            DO NOTHING
            RETURNING *;
        `;
        const insertRes = await queryClient.query(insertSql, [
            parsedDoc.id,
            parsedDoc.version_id,
            parsedDoc.document_id,
            parsedDoc.adapter_name,
            parsedDoc.adapter_version,
            parsedDoc.canonical_text,
            JSON.stringify(parsedDoc.structural_units),
            JSON.stringify(parsedDoc.metadata),
            parsedDoc.parsed_at,
        ]);

        if (insertRes.rows && insertRes.rows.length > 0) {
            const insertedRow = insertRes.rows[0];
            finalDoc = {
                id: insertedRow.id,
                version_id: insertedRow.version_id,
                document_id: insertedRow.document_id,
                adapter_name: insertedRow.adapter_name,
                adapter_version: insertedRow.adapter_version,
                canonical_text: insertedRow.canonical_text,
                structural_units: typeof insertedRow.structural_units === 'string' ? JSON.parse(insertedRow.structural_units) : insertedRow.structural_units,
                metadata: typeof insertedRow.metadata === 'string' ? JSON.parse(insertedRow.metadata) : insertedRow.metadata,
                parsed_at: insertedRow.parsed_at,
                existing: false,
            };
        } else {
            // Concurrent transaction already inserted it
            const selectRes = await queryClient.query(
                `SELECT * FROM kos_parsed_documents WHERE version_id = $1 AND adapter_name = $2 AND adapter_version = $3`,
                [parsedDoc.version_id, parsedDoc.adapter_name, parsedDoc.adapter_version]
            );
            if (selectRes.rows && selectRes.rows.length > 0) {
                const r = selectRes.rows[0];
                finalDoc = {
                    id: r.id,
                    version_id: r.version_id,
                    document_id: r.document_id,
                    adapter_name: r.adapter_name,
                    adapter_version: r.adapter_version,
                    canonical_text: r.canonical_text,
                    structural_units: typeof r.structural_units === 'string' ? JSON.parse(r.structural_units) : r.structural_units,
                    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
                    parsed_at: r.parsed_at,
                    existing: true,
                };
            }
        }

        await queryClient.query('COMMIT');
    } catch (dbErr) {
        await queryClient.query('ROLLBACK');
        throw dbErr;
    }

    return finalDoc;
}

module.exports = {
    parseDocumentVersion,
};

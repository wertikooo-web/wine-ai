'use strict';

/**
 * WINE AI KOS - Format Adapter Registry (Step 2C.4)
 *
 * Resolves format adapters based strictly on detected MIME type.
 */

const htmlAdapter = require('./adapters/htmlAdapter');
const textAdapter = require('./adapters/textAdapter');
const pdfAdapter = require('./adapters/pdfAdapter');
const docxAdapter = require('./adapters/docxAdapter');

const REGISTRY = new Map([
    ['text/html', htmlAdapter],
    ['text/plain', textAdapter],
    ['application/pdf', pdfAdapter],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxAdapter],
    ['application/docx', docxAdapter],
]);

function getAdapterForMime(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') {
        throw Object.assign(new Error('KOS_UNSUPPORTED_MIME_TYPE: MIME type is missing or invalid'), { code: 'KOS_UNSUPPORTED_MIME_TYPE', mimeType });
    }

    const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
    const adapter = REGISTRY.get(normalizedMime);

    if (!adapter) {
        throw Object.assign(new Error(`KOS_UNSUPPORTED_MIME_TYPE: Unsupported MIME type "${mimeType}"`), { code: 'KOS_UNSUPPORTED_MIME_TYPE', mimeType });
    }

    return adapter;
}

module.exports = {
    getAdapterForMime,
    REGISTRY,
};

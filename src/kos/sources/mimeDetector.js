'use strict';

/**
 * WINE AI KOS - MIME Detection Module (Step 2C.2)
 *
 * Classifies content type from raw Buffer magic bytes:
 * - PDF (%PDF-)
 * - DOCX (Zip header PK\x03\x04)
 * - HTML (<!DOCTYPE html, <html, <head, <body)
 * - Plain text
 */

function detectMimeType(buffer, declaredType = '') {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        return 'application/octet-stream';
    }

    // 1. PDF Check (%PDF-)
    if (buffer.length >= 5 && buffer.slice(0, 5).toString('ascii') === '%PDF-') {
        return 'application/pdf';
    }

    // 2. ZIP / DOCX Check (PK\x03\x04)
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
        // Classify ZIP as DOCX if declared MIME is docx or contains openxmlformats
        if (declaredType.includes('wordprocessingml') || declaredType.includes('docx')) {
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        }
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }

    // 3. HTML Check (Inspect first 2048 bytes)
    const snippet = buffer.slice(0, 2048).toString('utf8').toLowerCase().trim();
    if (
        snippet.includes('<!doctype html') ||
        snippet.includes('<html') ||
        snippet.includes('<head') ||
        snippet.includes('<body') ||
        snippet.includes('<title') ||
        snippet.includes('<div') ||
        snippet.includes('<p')
    ) {
        return 'text/html';
    }

    // 4. Plain Text fallback if valid UTF-8 and declared as text
    if (declaredType.includes('text/plain')) {
        return 'text/plain';
    }

    // Default declared fallback or octet-stream
    if (declaredType.includes('html')) return 'text/html';
    if (declaredType.includes('pdf')) return 'application/pdf';

    return 'text/plain';
}

module.exports = {
    detectMimeType,
};

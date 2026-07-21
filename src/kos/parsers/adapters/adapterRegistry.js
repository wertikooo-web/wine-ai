'use strict';

/**
 * WINE AI KOS - Format Adapter Registry (Step 2B.1 Production)
 *
 * Magic bytes signature detection, verified MIME types, extension hints, and Hard Timeout via Worker Threads.
 * Hard timeout abruptly terminates worker execution via worker.terminate() if parsing exceeds limit.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { KosParserError } = require('../core/parserContracts');
const { parseTextDocument } = require('../core/textParser');
const { parseHtmlFormat } = require('./htmlAdapter');
const { parsePdfFormat } = require('./pdfAdapter');
const { parseDocxFormat } = require('./docxAdapter');

const WORKER_SCRIPT = path.resolve(__dirname, '../core/parserWorker.js');

function detectFormatFromMagicBytes(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

    if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
        return 'pdf';
    }

    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
        const str = buffer.toString('utf8', 0, Math.min(buffer.length, 2000));
        if (str.includes('word/') || str.includes('[Content_Types].xml')) {
            return 'docx';
        }
        return 'zip';
    }

    const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 500)).toLowerCase().trim();
    if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.includes('<head>') || prefix.includes('<body>')) {
        return 'html';
    }

    return null;
}

function detectFormatFromMime(mimeType) {
    if (!mimeType || typeof mimeType !== 'string') return null;
    const clean = mimeType.split(';')[0].trim().toLowerCase();

    if (clean === 'text/html') return 'html';
    if (clean === 'application/pdf') return 'pdf';
    if (clean === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || clean === 'application/msword') return 'docx';
    if (clean === 'application/vnd.ms-word.document.macroenabled.12') return 'docm';
    if (clean.startsWith('text/')) return 'text';

    return null;
}

function detectFormatFromExtension(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const ext = filename.split('.').pop().toLowerCase();

    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'docm') return 'docm';
    if (ext === 'txt' || ext === 'md' || ext === 'csv') return 'text';

    return null;
}

function runInWorker(format, buffer, metadata, options, timeoutMs) {
    return new Promise((resolve, reject) => {
        let isSettled = false;

        const serializableOptions = { ...options };
        if (typeof options.now === 'function') {
            serializableOptions.fixedDate = options.now().toISOString();
            delete serializableOptions.now;
        }

        const worker = new Worker(WORKER_SCRIPT, {
            workerData: { format, buffer, metadata, options: serializableOptions },
        });

        const timer = setTimeout(() => {
            if (!isSettled) {
                isSettled = true;
                worker.terminate(); // Abruptly stop worker execution
                reject(new KosParserError('KOS_PARSE_TIMEOUT', `Format parsing hard-timed out after ${timeoutMs}ms.`));
            }
        }, timeoutMs);

        worker.on('message', (msg) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            worker.terminate();

            if (msg.success) {
                resolve(msg.result);
            } else {
                reject(new KosParserError(msg.error.code, msg.error.message, msg.error.details));
            }
        });

        worker.on('error', (err) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(timer);
            worker.terminate();
            reject(new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', err.message));
        });
    });
}

async function parseDocument(buffer, metadata = {}, options = {}) {
    if (buffer === undefined || buffer === null) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'Cannot parse null or undefined content.');
    }

    const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : Number(process.env.KOS_PARSER_TIMEOUT_MS || 30000);
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
    const declaredMime = metadata.mimeType || metadata.declaredMimeType || '';
    const filename = metadata.originalFilename || '';

    const magicFormat = detectFormatFromMagicBytes(buf);
    const mimeFormat = detectFormatFromMime(declaredMime);
    const extFormat = detectFormatFromExtension(filename);

    if (mimeFormat === 'docm' || extFormat === 'docm') {
        throw new KosParserError('KOS_PARSE_UNSUPPORTED_FORMAT', 'DOCM macro-enabled files are quarantined and unsupported on Step 2B.');
    }

    if (magicFormat === 'zip' && !extFormat) {
        throw new KosParserError('KOS_PARSE_FORMAT_MISMATCH', 'ZIP archive is missing recognizable OpenXML word/ structures or extension.');
    }

    let selectedFormat = magicFormat || mimeFormat || extFormat || 'text';
    const warnings = [];

    if (magicFormat && mimeFormat && magicFormat !== mimeFormat) {
        warnings.push({
            code: 'KOS_FORMAT_DECLARATION_MISMATCH',
            message: `Declared MIME type "${declaredMime}" (${mimeFormat}) conflicts with magic bytes signature (${magicFormat}). Using magic bytes adapter (${magicFormat}).`,
            declaredMime,
            magicFormat,
        });
    }

    if (timeoutMs <= 0) {
        throw new KosParserError('KOS_PARSE_TIMEOUT', `Format parsing hard-timed out after ${timeoutMs}ms.`);
    }

    // Direct in-process fallback if requested or execute via worker
    const parsedDoc = options.useWorker === false
        ? await (selectedFormat === 'html' ? parseHtmlFormat(buf, metadata, options)
            : selectedFormat === 'pdf' ? parsePdfFormat(buf, metadata, options)
            : selectedFormat === 'docx' ? parseDocxFormat(buf, metadata, options)
            : parseTextDocument(buf, metadata, options))
        : await runInWorker(selectedFormat, buf, metadata, options, timeoutMs);

    if (warnings.length > 0) {
        parsedDoc.warnings.push(...warnings);
    }

    return parsedDoc;
}

module.exports = {
    detectFormatFromMagicBytes,
    detectFormatFromMime,
    detectFormatFromExtension,
    parseDocument,
};

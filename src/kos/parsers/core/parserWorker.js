'use strict';

/**
 * WINE AI KOS - Parser Worker Thread (Step 2B.1 Hard Timeout)
 *
 * Runs format parsing in an isolated Worker thread.
 * Spawns per request or from pool, and can be terminated abruptly on CPU-bound or I/O timeouts.
 */

const { parentPort, workerData } = require('worker_threads');

if (parentPort && workerData) {
    const { parseTextDocument } = require('./textParser');
    const { parseHtmlFormat } = require('../adapters/htmlAdapter');
    const { parsePdfFormat } = require('../adapters/pdfAdapter');
    const { parseDocxFormat } = require('../adapters/docxAdapter');

    (async () => {
        try {
            const { buffer, metadata, options = {}, format } = workerData;
            const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.data || buffer);

            if (options.fixedDate && !options.now) {
                const fixedIso = options.fixedDate;
                options.now = () => new Date(fixedIso);
            }

            let result;
            if (format === 'html') {
                result = await parseHtmlFormat(buf, metadata, options);
            } else if (format === 'pdf') {
                result = await parsePdfFormat(buf, metadata, options);
            } else if (format === 'docx') {
                result = await parseDocxFormat(buf, metadata, options);
            } else if (format === 'cpu_block_test') {
                // Fixture test for hard worker termination
                while (true) {} // Infinite loop to test hard termination
            } else {
                result = parseTextDocument(buf, metadata, options);
            }

            parentPort.postMessage({ success: true, result });
        } catch (err) {
            parentPort.postMessage({
                success: false,
                error: {
                    name: err.name,
                    code: err.code || 'KOS_PARSE_ERROR',
                    message: err.message,
                    details: err.details || {},
                },
            });
        }
    })();
}

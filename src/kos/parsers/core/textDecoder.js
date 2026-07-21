'use strict';

/**
 * WINE AI KOS - Text Decoder Stage (Step 2B Core)
 */

const { KosParserError, PARSER_LIMITS } = require('./parserContracts');

function decodeText(rawBufferOrString, options = {}) {
    if (rawBufferOrString === undefined || rawBufferOrString === null) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'Cannot decode null or undefined content.');
    }

    const utf8Mode = options.utf8Mode || 'strict'; // 'strict' | 'lenient'

    let buffer;
    if (Buffer.isBuffer(rawBufferOrString)) {
        buffer = rawBufferOrString;
    } else if (typeof rawBufferOrString === 'string') {
        buffer = Buffer.from(rawBufferOrString, 'utf8');
    } else {
        throw new KosParserError('KOS_PARSE_INVALID_INPUT_TYPE', 'Content argument must be a Buffer or String.');
    }

    if (buffer.length === 0) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'Raw content buffer is empty (0 bytes).');
    }

    if (buffer.length > PARSER_LIMITS.MAX_INPUT_BYTES) {
        throw new KosParserError(
            'KOS_PARSE_SOURCE_TOO_LARGE',
            `Source byte length (${buffer.length}) exceeds maximum limit (${PARSER_LIMITS.MAX_INPUT_BYTES}).`
        );
    }

    let hasBom = false;
    let rawText;

    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
        hasBom = true;
        rawText = buffer.slice(3).toString('utf8');
    } else {
        rawText = buffer.toString('utf8');
    }

    const warnings = [];
    if (rawText.includes('\uFFFD')) {
        const replacementCount = (rawText.match(/\uFFFD/g) || []).length;
        if (utf8Mode === 'strict') {
            throw new KosParserError(
                'KOS_PARSE_INVALID_UTF8',
                `Source content contains ${replacementCount} invalid UTF-8 byte sequence(s).`
            );
        } else {
            warnings.push({
                code: 'KOS_PARSE_INVALID_UTF8_REPLACED',
                count: replacementCount,
                message: `${replacementCount} invalid UTF-8 byte sequence(s) were replaced with \\uFFFD.`,
            });
        }
    }

    return {
        rawText,
        hasBom,
        byteLength: buffer.length,
        warnings,
    };
}

module.exports = {
    decodeText,
};

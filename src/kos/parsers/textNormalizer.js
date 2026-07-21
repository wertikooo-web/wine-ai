'use strict';

/**
 * WINE AI KOS - Text Normalizer Stage (Step 2A)
 * Applies canonical text normalization rules: CRLF -> LF, Unicode NFC normalization, BOM record.
 * Preserves text length or logs exact transformations.
 */

function normalizeText(decodedResult) {
    const { rawText, hasBom } = decodedResult;
    const transformations = [];

    if (hasBom) {
        transformations.push('bom_stripped');
    }

    let canonicalText = rawText;

    // 1. CRLF -> LF normalization
    if (canonicalText.includes('\r\n')) {
        canonicalText = canonicalText.replace(/\r\n/g, '\n');
        transformations.push('crlf_to_lf');
    }

    // 2. Unicode NFC Normalization
    const nfcNormalized = canonicalText.normalize('NFC');
    if (nfcNormalized !== canonicalText) {
        canonicalText = nfcNormalized;
        transformations.push('unicode_nfc');
    }

    return {
        canonicalText,
        transformations,
    };
}

module.exports = {
    normalizeText,
};

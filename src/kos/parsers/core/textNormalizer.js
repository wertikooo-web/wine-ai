'use strict';

/**
 * WINE AI KOS - Text Normalizer Stage (Step 2B Core)
 */

function normalizeText(decodedResult) {
    const { rawText, hasBom } = decodedResult;
    const transformations = [];

    if (hasBom) {
        transformations.push('bom_stripped');
    }

    let canonicalText = rawText;

    if (canonicalText.includes('\r\n')) {
        canonicalText = canonicalText.replace(/\r\n/g, '\n');
        transformations.push('crlf_to_lf');
    }

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

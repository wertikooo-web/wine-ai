'use strict';

/**
 * WINE AI KOS - Deterministic Extractor Registry (Step 3B Refined Content Hash)
 *
 * Central registry of deterministic extractors with a content-sensitive registry fingerprint.
 * Any modification to label dictionaries, regexes, or extractor code changes the fingerprint.
 */

const crypto = require('crypto');
const { canonicalJsonStringify } = require('../identity/candidateFingerprint');
const { extractLabelValuePairs } = require('./extractors/labelValueExtractor');
const { extractTableCells } = require('./extractors/tableExtractor');
const { extractHeadingEntityNames } = require('./extractors/headingEntityExtractor');
const { WINE_LABELS, WINE_LABEL_DICTIONARY_VERSION } = require('./dictionaries/wineLabels');
const { WINERY_LABELS, WINERY_LABEL_DICTIONARY_VERSION } = require('./dictionaries/wineryLabels');

const DETERMINISTIC_EXTRACTORS = Object.freeze([
    {
        name: 'kos-label-value-extractor',
        version: '1.0.0',
        supportedFormats: Object.freeze(['html', 'pdf', 'docx', 'text']),
        supportedFields: Object.freeze(['wine.alcoholPercent', 'wine.vintageYear', 'wine.volumeMl', 'wine.price', 'winery.brandName', 'winery.foundingYear', 'winery.website', 'winery.email', 'winery.phone']),
        extractFn: extractLabelValuePairs,
    },
    {
        name: 'kos-table-extractor',
        version: '1.0.0',
        supportedFormats: Object.freeze(['html', 'docx']),
        supportedFields: Object.freeze(['wine.alcoholPercent', 'wine.vintageYear', 'wine.volumeMl', 'wine.price', 'winery.foundingYear']),
        extractFn: extractTableCells,
    },
    {
        name: 'kos-heading-entity-extractor',
        version: '1.0.0',
        supportedFormats: Object.freeze(['html', 'pdf', 'docx', 'text']),
        supportedFields: Object.freeze(['wine.name']),
        extractFn: extractHeadingEntityNames,
    },
]);

function computeContentHash(data) {
    const canonicalJson = canonicalJsonStringify(data);
    return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

function getExtractorRegistryFingerprint(customWineLabels = WINE_LABELS, customWineryLabels = WINERY_LABELS) {
    const wineLabelsHash = computeContentHash(customWineLabels);
    const wineryLabelsHash = computeContentHash(customWineryLabels);

    const extractorsMeta = DETERMINISTIC_EXTRACTORS.map((ext) => ({
        name: ext.name,
        version: ext.version,
        supportedFields: ext.supportedFields,
        supportedFormats: ext.supportedFormats,
        codeSignature: computeContentHash({
            name: ext.name,
            version: ext.version,
            fnString: ext.extractFn.toString(),
        }),
    }));

    const fullRegistryMeta = {
        schemaVersion: '1.0.0',
        wineDictionaryVersion: WINE_LABEL_DICTIONARY_VERSION,
        wineLabelsHash,
        wineryDictionaryVersion: WINERY_LABEL_DICTIONARY_VERSION,
        wineryLabelsHash,
        extractors: extractorsMeta,
    };

    return computeContentHash(fullRegistryMeta);
}

function getRegisteredExtractors() {
    return DETERMINISTIC_EXTRACTORS;
}

module.exports = {
    getRegisteredExtractors,
    getExtractorRegistryFingerprint,
    computeContentHash,
};

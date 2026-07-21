'use strict';

/**
 * WINE AI KOS - Label-Value Deterministic Extractor (Step 3B Refined Boundary)
 *
 * Extracts label:value pairs across text structural units using multilingual label dictionaries.
 * Produces pure EvidenceDrafts containing both Label span and Value span.
 */

const { WINE_LABELS } = require('../dictionaries/wineLabels');
const { WINERY_LABELS } = require('../dictionaries/wineryLabels');
const { findNearestHeadingContext } = require('../context/headingContext');
const { createCandidateDraft } = require('../../contracts/factCandidate');
const { createEvidenceDraft } = require('../../contracts/evidence');

const EXTRACTOR_NAME = 'kos-label-value-extractor';
const EXTRACTOR_VERSION = '1.0.0';

const CONFIDENCE_LABEL_VALUE = Object.freeze({
    score: 0.95,
    method: 'deterministic_exact_match',
    factors: Object.freeze([
        { code: 'explicit_field_label', contribution: 0.55 },
        { code: 'adjacent_structural_value', contribution: 0.25 },
        { code: 'value_matches_field_policy', contribution: 0.15 },
    ]),
});

function extractLabelValuePairs(parsedDocument, options = {}) {
    const drafts = [];
    const warnings = [];
    if (!parsedDocument || !Array.isArray(parsedDocument.structuralUnits)) {
        return { drafts, warnings };
    }

    const units = parsedDocument.structuralUnits;
    const allLabels = [...Object.values(WINE_LABELS), ...Object.values(WINERY_LABELS)];

    for (let idx = 0; idx < units.length; idx++) {
        const unit = units[idx];
        if (!unit || !unit.text) continue;

        if (unit.text.startsWith('# ')) continue;

        const headingCtx = findNearestHeadingContext(units, idx);
        const entityRef = headingCtx
            ? { kind: 'provisional', provisionalKey: headingCtx.provisionalKey, displayName: headingCtx.headingText }
            : { kind: 'provisional', provisionalKey: 'default-winery', displayName: 'Default Winery' };

        for (const item of allLabels) {
            const fieldPath = item.fieldPath;
            const entityType = fieldPath.startsWith('wine.') ? 'wine' : 'winery';

            for (const [lang, labels] of Object.entries(item.labels)) {
                for (const label of labels) {
                    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`(?:^|\\s)(${escapedLabel}\\s*[:\\-—=])\\s*([^;\\n\\r]+)`, 'i');
                    const match = regex.exec(unit.text);

                    if (match) {
                        const rawLabel = match[1].trim();
                        const rawValue = match[2].trim();
                        if (!rawLabel || !rawValue) continue;

                        const labelMatchIdx = match.index + match[0].indexOf(rawLabel);
                        const labelUtf16Start = (unit.range?.utf16Start || 0) + labelMatchIdx;
                        const labelUtf16End = labelUtf16Start + rawLabel.length;

                        const valMatchIdx = match.index + match[0].indexOf(rawValue);
                        const valUtf16Start = (unit.range?.utf16Start || 0) + valMatchIdx;
                        const valUtf16End = valUtf16Start + rawValue.length;

                        let valueType = 'string';
                        let unitAttr = null;

                        if (fieldPath === 'wine.alcoholPercent') { valueType = 'decimal'; unitAttr = 'percent_abv'; }
                        else if (fieldPath === 'wine.vintageYear' || fieldPath === 'winery.foundingYear') { valueType = 'year'; }
                        else if (fieldPath === 'wine.volumeMl') { valueType = 'integer'; unitAttr = 'ml'; }
                        else if (fieldPath === 'wine.price') { valueType = 'money'; }
                        else if (fieldPath === 'winery.website') { valueType = 'url'; }
                        else if (fieldPath === 'winery.email') { valueType = 'email'; }
                        else if (fieldPath === 'winery.phone') { valueType = 'phone'; }

                        const evidenceDraft = createEvidenceDraft({
                            evidenceType: 'label_value_pair',
                            spans: [
                                { quote: rawLabel, range: { representation: 'canonical-v1', utf16Start: labelUtf16Start, utf16End: labelUtf16End }, structuralUnitIds: [unit.id] },
                                { quote: rawValue, range: { representation: 'canonical-v1', utf16Start: valUtf16Start, utf16End: valUtf16End }, structuralUnitIds: [unit.id] },
                            ],
                        });

                        const draft = createCandidateDraft({
                            entityType,
                            entityRef,
                            fieldPath,
                            rawValue,
                            valueType,
                            unit: unitAttr,
                            language: lang,
                            evidenceDrafts: [evidenceDraft],
                            confidence: CONFIDENCE_LABEL_VALUE,
                            extractor: { name: EXTRACTOR_NAME, version: EXTRACTOR_VERSION },
                        });

                        drafts.push(draft);
                        break;
                    }
                }
            }
        }
    }

    return { drafts, warnings };
}

module.exports = {
    EXTRACTOR_NAME,
    EXTRACTOR_VERSION,
    CONFIDENCE_LABEL_VALUE,
    extractLabelValuePairs,
};

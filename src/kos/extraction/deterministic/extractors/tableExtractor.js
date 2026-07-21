'use strict';

/**
 * WINE AI KOS - Table Deterministic Extractor (Step 3B Refined Boundary)
 *
 * Extracts label-cell | value-cell pairs from table structures (DOCX / HTML).
 * Emits pure EvidenceDrafts containing both Label cell span and Value cell span.
 */

const { WINE_LABELS } = require('../dictionaries/wineLabels');
const { WINERY_LABELS } = require('../dictionaries/wineryLabels');
const { findNearestHeadingContext } = require('../context/headingContext');
const { createCandidateDraft } = require('../../contracts/factCandidate');
const { createEvidenceDraft } = require('../../contracts/evidence');

const EXTRACTOR_NAME = 'kos-table-extractor';
const EXTRACTOR_VERSION = '1.0.0';

const CONFIDENCE_TABLE_CELL = Object.freeze({
    score: 0.94,
    method: 'deterministic_table_mapping',
    factors: Object.freeze([
        { code: 'known_table_header', contribution: 0.54 },
        { code: 'adjacent_table_cell_value', contribution: 0.25 },
        { code: 'value_matches_field_policy', contribution: 0.15 },
    ]),
});

function extractTableCells(parsedDocument, options = {}) {
    const drafts = [];
    const warnings = [];

    if (!parsedDocument || !Array.isArray(parsedDocument.structuralUnits)) {
        return { drafts, warnings };
    }

    const units = parsedDocument.structuralUnits;
    const tableUnitsMap = new Map();

    for (let idx = 0; idx < units.length; idx++) {
        const unit = units[idx];
        const tblIdx = unit.docxLocation?.tableIndex || unit.htmlLocation?.tableIndex;
        if (tblIdx) {
            if (!tableUnitsMap.has(tblIdx)) tableUnitsMap.set(tblIdx, []);
            tableUnitsMap.get(tblIdx).push({ unit, unitIndex: idx });
        }
    }

    const allLabels = [...Object.values(WINE_LABELS), ...Object.values(WINERY_LABELS)];

    for (const [tblIdx, tblUnits] of tableUnitsMap.entries()) {
        const rowMap = new Map();
        for (const item of tblUnits) {
            const rowIdx = item.unit.docxLocation?.rowIndex || item.unit.htmlLocation?.rowIndex || 1;
            if (!rowMap.has(rowIdx)) rowMap.set(rowIdx, []);
            rowMap.get(rowIdx).push(item);
        }

        for (const [rIdx, rowItems] of rowMap.entries()) {
            if (rowItems.length < 2) continue;

            const labelItem = rowItems[0];
            const valueItem = rowItems[1];

            const labelText = labelItem.unit.text.toLowerCase().trim();
            const rawValue = valueItem.unit.text.trim();
            if (!labelText || !rawValue) continue;

            const headingCtx = findNearestHeadingContext(units, labelItem.unitIndex);
            const entityRef = headingCtx
                ? { kind: 'provisional', provisionalKey: headingCtx.provisionalKey, displayName: headingCtx.headingText }
                : { kind: 'provisional', provisionalKey: 'default-winery', displayName: 'Default Winery' };

            for (const dictItem of allLabels) {
                const fieldPath = dictItem.fieldPath;
                const entityType = fieldPath.startsWith('wine.') ? 'wine' : 'winery';

                for (const [lang, labels] of Object.entries(dictItem.labels)) {
                    for (const label of labels) {
                        if (labelText.includes(label.toLowerCase())) {
                            let valueType = 'string';
                            let unitAttr = null;

                            if (fieldPath === 'wine.alcoholPercent') { valueType = 'decimal'; unitAttr = 'percent_abv'; }
                            else if (fieldPath === 'wine.vintageYear' || fieldPath === 'winery.foundingYear') { valueType = 'year'; }
                            else if (fieldPath === 'wine.volumeMl') { valueType = 'integer'; unitAttr = 'ml'; }
                            else if (fieldPath === 'wine.price') { valueType = 'money'; }

                            const evidenceDraft = createEvidenceDraft({
                                evidenceType: 'table_cell',
                                spans: [
                                    { quote: labelItem.unit.text, range: labelItem.unit.range, structuralUnitIds: [labelItem.unit.id] },
                                    { quote: rawValue, range: valueItem.unit.range, structuralUnitIds: [valueItem.unit.id] },
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
                                confidence: CONFIDENCE_TABLE_CELL,
                                extractor: { name: EXTRACTOR_NAME, version: EXTRACTOR_VERSION },
                            });

                            drafts.push(draft);
                            break;
                        }
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
    CONFIDENCE_TABLE_CELL,
    extractTableCells,
};

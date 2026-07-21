'use strict';

/**
 * WINE AI KOS - Table Extractor Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { extractTableCells, CONFIDENCE_TABLE_CELL } = require('../src/kos/extraction/deterministic/extractors/tableExtractor');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    const parsedDoc = {
        sourceId: 'src_tbl',
        sourceChecksum: 'chk_tbl',
        documentFingerprint: 'doc_fp_tbl',
        canonicalText: 'Tărie alcoolică | 13,5%\nAnul recoltei | 2019',
        structuralUnits: [
            { id: 'cell_1_1', text: 'Tărie alcoolică', docxLocation: { tableIndex: 1, rowIndex: 1, cellIndex: 1 }, range: { utf16Start: 0, utf16End: 15 } },
            { id: 'cell_1_2', text: '13,5%', docxLocation: { tableIndex: 1, rowIndex: 1, cellIndex: 2 }, range: { utf16Start: 18, utf16End: 23 } },
            { id: 'cell_2_1', text: 'Anul recoltei', docxLocation: { tableIndex: 1, rowIndex: 2, cellIndex: 1 }, range: { utf16Start: 24, utf16End: 37 } },
            { id: 'cell_2_2', text: '2019', docxLocation: { tableIndex: 1, rowIndex: 2, cellIndex: 2 }, range: { utf16Start: 40, utf16End: 44 } },
        ],
    };

    const { drafts } = extractTableCells(parsedDoc);
    assertOk(drafts.length >= 2);

    const alcDraft = drafts.find((d) => d.fieldPath === 'wine.alcoholPercent');
    assertOk(alcDraft);
    assertEqual(alcDraft.rawValue, '13,5%');

    // 2-Span Evidence Verification (Label cell + Value cell)
    const ev = alcDraft.evidenceDrafts[0];
    assertEqual(ev.evidenceType, 'table_cell');
    assertEqual(ev.spans.length, 2);
    assertEqual(ev.spans[0].quote, 'Tărie alcoolică');
    assertEqual(ev.spans[1].quote, '13,5%');
    assertEqual(alcDraft.confidence.score, CONFIDENCE_TABLE_CELL.score);

    console.log(`kosTableExtractor.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };

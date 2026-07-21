'use strict';

/**
 * WINE AI KOS - Comprehensive Label-Value Extractor Test Suite (Step 3B Production)
 */

const assert = require('assert');
const { extractLabelValuePairs, CONFIDENCE_LABEL_VALUE } = require('../src/kos/extraction/deterministic/extractors/labelValueExtractor');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Multilingual Label & Value Parsing (Romanian, Russian, English)
    const canonicalText = `Alcool: 13,5%
Крепость: 14%
Alcohol: 13.5% abv
Volum: 750 ml
Capacitate: 0,75 L
Anul recoltei: 2019
Preț: 450 MDL
Price: 25 EUR
Website: https://castelmimi.md
Email: info@castelmimi.md
Telefon: +373 22 123 456`;

    const parsedDoc = {
        sourceId: 'src_label_val',
        sourceChecksum: 'chk_111',
        documentFingerprint: 'doc_fp_222',
        canonicalText,
        structuralUnits: [
            { id: 'u_1', text: 'Alcool: 13,5%', range: { utf16Start: 0, utf16End: 13 } },
            { id: 'u_2', text: 'Крепость: 14%', range: { utf16Start: 14, utf16End: 27 } },
            { id: 'u_3', text: 'Alcohol: 13.5% abv', range: { utf16Start: 28, utf16End: 46 } },
            { id: 'u_4', text: 'Volum: 750 ml', range: { utf16Start: 47, utf16End: 60 } },
            { id: 'u_5', text: 'Capacitate: 0,75 L', range: { utf16Start: 61, utf16End: 79 } },
            { id: 'u_6', text: 'Anul recoltei: 2019', range: { utf16Start: 80, utf16End: 99 } },
            { id: 'u_7', text: 'Preț: 450 MDL', range: { utf16Start: 100, utf16End: 113 } },
            { id: 'u_8', text: 'Price: 25 EUR', range: { utf16Start: 114, utf16End: 127 } },
            { id: 'u_9', text: 'Website: https://castelmimi.md', range: { utf16Start: 128, utf16End: 158 } },
            { id: 'u_10', text: 'Email: info@castelmimi.md', range: { utf16Start: 159, utf16End: 184 } },
            { id: 'u_11', text: 'Telefon: +373 22 123 456', range: { utf16Start: 185, utf16End: 209 } },
        ],
    };

    const { drafts } = extractLabelValuePairs(parsedDoc);
    assertOk(drafts.length >= 10);

    // 2. Mandatory Label + Value 2-Span Evidence Verification
    const roAlcDraft = drafts.find((d) => d.language === 'ro' && d.fieldPath === 'wine.alcoholPercent');
    assertOk(roAlcDraft);
    const ev = roAlcDraft.evidenceDrafts[0];
    assertEqual(ev.evidenceType, 'label_value_pair');
    assertEqual(ev.spans.length, 2);
    assertEqual(ev.spans[0].quote, 'Alcool:');
    assertEqual(ev.spans[1].quote, '13,5%');
    assertEqual(roAlcDraft.confidence.score, CONFIDENCE_LABEL_VALUE.score);

    // 3. Russian Alcohol Parsing
    const ruAlcDraft = drafts.find((d) => d.language === 'ru' && d.fieldPath === 'wine.alcoholPercent');
    assertOk(ruAlcDraft);
    assertEqual(ruAlcDraft.rawValue, '14%');

    // 4. Volume ml vs Litres Parsing
    const volMlDraft = drafts.find((d) => d.rawValue === '750 ml');
    assertOk(volMlDraft);
    const volLDraft = drafts.find((d) => d.rawValue === '0,75 L');
    assertOk(volLDraft);

    // 5. Price EUR vs MDL
    const priceMdlDraft = drafts.find((d) => d.rawValue === '450 MDL');
    assertOk(priceMdlDraft);
    const priceEurDraft = drafts.find((d) => d.rawValue === '25 EUR');
    assertOk(priceEurDraft);

    // 6. Website, Email, Phone
    const webDraft = drafts.find((d) => d.fieldPath === 'winery.website');
    assertOk(webDraft);
    assertEqual(webDraft.rawValue, 'https://castelmimi.md');

    const emailDraft = drafts.find((d) => d.fieldPath === 'winery.email');
    assertOk(emailDraft);
    assertEqual(emailDraft.rawValue, 'info@castelmimi.md');

    const phoneDraft = drafts.find((d) => d.fieldPath === 'winery.phone');
    assertOk(phoneDraft);
    assertEqual(phoneDraft.rawValue, '+373 22 123 456');

    // 7. Unicode NFD Label Normalization Matching Test
    const nfdText = 'Alcool:'.normalize('NFD') + ' 13,5%';
    const nfdDoc = {
        canonicalText: nfdText,
        structuralUnits: [{ id: 'u_nfd', text: nfdText, range: { utf16Start: 0, utf16End: nfdText.length } }],
    };
    const { drafts: nfdDrafts } = extractLabelValuePairs(nfdDoc);
    assertOk(nfdDrafts.length >= 1);

    console.log(`kosLabelValueExtractor.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };

'use strict';

/**
 * WINE AI KOS - Parsed Document Builder Unit Test Suite (Step 2C.4)
 *
 * Verifies:
 * - Primary Offset Invariant: canonical_text.slice(charStart, charEnd) === block.text
 * - Text normalization (CRLF -> LF, NFC, NBSP -> space, NUL removal)
 * - Empty block filtering
 * - Deterministic double-newline block concatenation
 */

const assert = require('assert');
const { buildParsedDocument, normalizeText } = require('../src/kos/parsing/parsedDocumentBuilder');

async function run() {
    let assertionCount = 0;

    // 1. Normalize Text Tests
    assert.strictEqual(normalizeText('Hello\r\nWorld'), 'Hello\nWorld');
    assert.strictEqual(normalizeText('Title\u00A0Text'), 'Title Text');
    assert.strictEqual(normalizeText('Clean\0Byte'), 'CleanByte');
    assert.strictEqual(normalizeText('   Space   '), 'Space');
    assertionCount += 4;

    // 2. Build ParsedDocument with Offset Invariant Verification
    const sampleBlocks = [
        { type: 'heading', text: 'Château Purcari', headingLevel: 1 },
        { type: 'paragraph', text: 'Purcari Wineries is a leading wine producer in Moldova.\r\nEstablished in 1827.' },
        { type: 'list_item', text: 'Negru de Purcari\u00A0Limited Edition' },
    ];

    const doc = buildParsedDocument({
        documentVersionId: 'ver_test_001',
        documentId: 'doc_test_001',
        adapterName: 'html_adapter',
        adapterVersion: '1.0.0',
        title: 'Purcari Overview',
        blocks: sampleBlocks,
        warnings: ['Minor parse notice'],
    });

    assert.ok(doc.id.startsWith('pdoc_'));
    assert.strictEqual(doc.version_id, 'ver_test_001');
    assert.strictEqual(doc.metadata.title, 'Purcari Overview');
    assert.strictEqual(doc.structural_units.length, 3);
    assertionCount += 4;

    // Primary Offset Invariant Assertion for every block
    for (let i = 0; i < doc.structural_units.length; i++) {
        const unit = doc.structural_units[i];
        const sliced = doc.canonical_text.slice(unit.charStart, unit.charEnd);
        assert.strictEqual(sliced, unit.text, `Offset invariant violated at unit ${i}`);
        assertionCount += 1;
    }

    // 3. Empty Block Removal Test
    const docWithEmpty = buildParsedDocument({
        documentVersionId: 'ver_test_002',
        adapterName: 'text_adapter',
        blocks: [
            { type: 'paragraph', text: 'First Paragraph' },
            { type: 'paragraph', text: '   ' },
            { type: 'paragraph', text: '\r\n\0' },
            { type: 'paragraph', text: 'Second Paragraph' },
        ],
    });
    assert.strictEqual(docWithEmpty.structural_units.length, 2);
    assert.strictEqual(docWithEmpty.structural_units[0].text, 'First Paragraph');
    assert.strictEqual(docWithEmpty.structural_units[1].text, 'Second Paragraph');
    assertionCount += 3;

    console.log(`kosParsedDocumentBuilder.test.js: All ${assertionCount} assertions passed successfully!`);
    return { assertionCount };
}

module.exports = { run };

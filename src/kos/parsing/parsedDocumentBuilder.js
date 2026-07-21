'use strict';

/**
 * WINE AI KOS - Parsed Document Builder (Step 2C.4)
 *
 * Constructs a normalized ParsedDocument from adapter blocks and guarantees the Primary Offset Invariant:
 * For every block in structural_units:
 *   canonical_text.slice(block.charStart, block.charEnd) === block.text
 */

const crypto = require('crypto');

function generateId(prefix = 'pdoc') {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/\r\n/g, '\n')
        .replace(/\0/g, '')
        .replace(/\u00A0/g, ' ')
        .normalize('NFC')
        .trim();
}

function buildParsedDocument({
    documentVersionId,
    documentId = null,
    adapterName,
    adapterVersion = '1.0.0',
    title = '',
    blocks = [],
    warnings = [],
}) {
    if (!documentVersionId) {
        throw Object.assign(new Error('KOS_BUILDER_VERSION_ID_REQUIRED'), { code: 'KOS_BUILDER_VERSION_ID_REQUIRED' });
    }
    if (!adapterName) {
        throw Object.assign(new Error('KOS_BUILDER_ADAPTER_NAME_REQUIRED'), { code: 'KOS_BUILDER_ADAPTER_NAME_REQUIRED' });
    }

    const validBlocks = [];
    const blockTexts = [];

    for (let i = 0; i < blocks.length; i++) {
        const rawBlock = blocks[i];
        if (!rawBlock || typeof rawBlock.text !== 'string') continue;

        const normalizedBlockText = normalizeText(rawBlock.text);
        if (!normalizedBlockText) continue; // Skip empty blocks

        validBlocks.push({
            type: rawBlock.type || 'paragraph',
            text: normalizedBlockText,
            headingLevel: rawBlock.headingLevel || undefined,
            metadata: rawBlock.metadata || undefined,
        });
        blockTexts.push(normalizedBlockText);
    }

    // Join blocks with double newline separator
    const canonicalText = blockTexts.join('\n\n');

    // Calculate precise character offsets
    const structuralUnits = [];
    let currentOffset = 0;

    for (let i = 0; i < validBlocks.length; i++) {
        const blk = validBlocks[i];
        const textLen = blk.text.length;

        const charStart = currentOffset;
        const charEnd = currentOffset + textLen;

        // Verify Primary Offset Invariant
        const sliced = canonicalText.slice(charStart, charEnd);
        if (sliced !== blk.text) {
            throw Object.assign(
                new Error(`KOS_BUILDER_OFFSET_INVARIANT_VIOLATED at block ${i}: expected "${blk.text}", got "${sliced}"`),
                { code: 'KOS_BUILDER_OFFSET_INVARIANT_VIOLATED', blockIndex: i }
            );
        }

        structuralUnits.push({
            type: blk.type,
            text: blk.text,
            charStart,
            charEnd,
            headingLevel: blk.headingLevel,
            metadata: blk.metadata,
        });

        // Account for \n\n separator between blocks
        currentOffset = charEnd + 2;
    }

    return {
        id: generateId('pdoc'),
        version_id: documentVersionId,
        document_id: documentId,
        adapter_name: adapterName,
        adapter_version: adapterVersion,
        canonical_text: canonicalText,
        structural_units: structuralUnits,
        metadata: {
            title: normalizeText(title),
            warnings: warnings || [],
            blockCount: structuralUnits.length,
        },
        parsed_at: new Date().toISOString(),
    };
}

module.exports = {
    buildParsedDocument,
    normalizeText,
};

'use strict';

/**
 * WINE AI KOS - Section Segmenter Stage (Step 2A Refined)
 * Parses document into structured sections, preambles, and headings with explicit ranges.
 * Supports ATX headings (#, ##), Setext headings (===, ---), and fenced code block protection.
 */

const { KosParserError, PARSER_LIMITS, createRange, createDocumentSection } = require('./parserContracts');

function findCodeBlockRanges(canonicalText) {
    const codeBlockRanges = [];
    const fenceRegex = /^(```|~~~)[\s\S]*?^\1/gm;
    let match;

    while ((match = fenceRegex.exec(canonicalText)) !== null) {
        const utf16Start = match.index;
        const utf16End = match.index + match[0].length;
        codeBlockRanges.push({ utf16Start, utf16End });
    }

    return codeBlockRanges;
}

function segmentDocument(canonicalText, title = '') {
    const codeBlockRanges = findCodeBlockRanges(canonicalText);

    const isInsideCodeBlock = (index) => {
        return codeBlockRanges.some((r) => index >= r.utf16Start && index <= r.utf16End);
    };

    const lines = canonicalText.split('\n');
    const sections = [];
    let currentUtf16 = 0;

    let currentSectionType = 'preamble';
    let currentHeadingText = null;
    let currentHeadingLevel = null;
    let currentHeadingStartUtf16 = 0;
    let currentHeadingEndUtf16 = 0;
    let bodyStartUtf16 = 0;
    let sectionBodyLines = [];

    const flushSection = (endUtf16) => {
        if (sections.length >= PARSER_LIMITS.MAX_SECTIONS) {
            throw new KosParserError(
                'KOS_PARSE_TOO_MANY_SECTIONS',
                `Document section count exceeded maximum limit of ${PARSER_LIMITS.MAX_SECTIONS}.`
            );
        }

        const bodyText = sectionBodyLines.join('\n');
        const sourceText = canonicalText.slice(currentHeadingStartUtf16, endUtf16);

        if (sourceText.trim().length === 0) return;

        const range = createRange({
            utf16Start: currentHeadingStartUtf16,
            utf16End: endUtf16,
            utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, currentHeadingStartUtf16), 'utf8'),
            utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, endUtf16), 'utf8'),
        });

        const headingRange = currentSectionType === 'preamble' ? null : createRange({
            utf16Start: currentHeadingStartUtf16,
            utf16End: currentHeadingEndUtf16,
            utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, currentHeadingStartUtf16), 'utf8'),
            utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, currentHeadingEndUtf16), 'utf8'),
        });

        const bodyRange = createRange({
            utf16Start: bodyStartUtf16,
            utf16End: endUtf16,
            utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, bodyStartUtf16), 'utf8'),
            utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, endUtf16), 'utf8'),
        });

        const sectionId = currentSectionType === 'preamble' && sections.length === 0 ? 'sec_preamble' : `sec_${sections.length}`;

        sections.push(createDocumentSection({
            id: sectionId,
            type: currentSectionType,
            headingText: currentHeadingText,
            bodyText,
            sourceText,
            range,
            headingRange,
            bodyRange,
        }));
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineStartUtf16 = currentUtf16;
        const lineEndUtf16 = currentUtf16 + line.length;
        const nextLine = i + 1 < lines.length ? lines[i + 1] : null;

        if (!isInsideCodeBlock(lineStartUtf16)) {
            // 1. ATX Headings (# Heading, ## Heading)
            const atxMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (atxMatch) {
                flushSection(lineStartUtf16 > 0 ? lineStartUtf16 - 1 : 0);

                currentSectionType = 'section';
                currentHeadingLevel = atxMatch[1].length;
                currentHeadingText = atxMatch[2].trim().slice(0, PARSER_LIMITS.MAX_HEADING_LENGTH);
                currentHeadingStartUtf16 = lineStartUtf16;
                currentHeadingEndUtf16 = lineEndUtf16;
                bodyStartUtf16 = lineEndUtf16 + 1;
                sectionBodyLines = [];
                currentUtf16 += line.length + 1;
                continue;
            }

            // 2. Setext Headings (Heading text followed on next line by === or ---)
            if (nextLine !== null && line.trim().length > 0 && !isInsideCodeBlock(lineEndUtf16 + 1)) {
                const setextMatch = nextLine.match(/^(={3,}|-{3,})$/);
                if (setextMatch) {
                    flushSection(lineStartUtf16 > 0 ? lineStartUtf16 - 1 : 0);

                    currentSectionType = 'section';
                    currentHeadingLevel = setextMatch[1].startsWith('=') ? 1 : 2;
                    currentHeadingText = line.trim().slice(0, PARSER_LIMITS.MAX_HEADING_LENGTH);
                    currentHeadingStartUtf16 = lineStartUtf16;

                    const underlineEndUtf16 = lineEndUtf16 + 1 + nextLine.length;
                    currentHeadingEndUtf16 = underlineEndUtf16;
                    bodyStartUtf16 = underlineEndUtf16 + 1;
                    sectionBodyLines = [];

                    currentUtf16 += line.length + 1 + nextLine.length + 1;
                    i++; // Skip underline line
                    continue;
                }
            }
        }

        sectionBodyLines.push(line);
        currentUtf16 += line.length + 1;
    }

    // Flush final section
    flushSection(canonicalText.length);

    // If document had no headings at all, return single preamble section
    if (sections.length === 0) {
        const fullRange = createRange({
            utf16Start: 0,
            utf16End: canonicalText.length,
            utf8ByteStart: 0,
            utf8ByteEnd: Buffer.byteLength(canonicalText, 'utf8'),
        });
        sections.push(createDocumentSection({
            id: 'sec_preamble',
            type: 'preamble',
            headingText: null,
            bodyText: canonicalText,
            sourceText: canonicalText,
            range: fullRange,
            headingRange: null,
            bodyRange: fullRange,
        }));
    }

    return {
        sections,
        codeBlockRanges,
    };
}

module.exports = {
    findCodeBlockRanges,
    segmentDocument,
};

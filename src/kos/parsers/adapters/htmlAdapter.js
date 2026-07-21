'use strict';

/**
 * WINE AI KOS - HTML Format Adapter (Step 2B.1 Production)
 *
 * Uses cheerio (v1.0.0) DOM parser.
 * Preserves structural hierarchy, excludes script/style elements, records HTML node provenance,
 * enforces resource limits, and calculates dynamic capability.
 */

const cheerio = require('cheerio');
const { KosParserError, createParsedDocument, createRange } = require('../core/parserContracts');
const { detectSuspiciousContent } = require('../core/suspiciousContentDetector');

const ADAPTER_NAME = 'kos-html-adapter';
const ADAPTER_VERSION = '1.0.0';

const HTML_LIMITS = {
    MAX_DOM_NODES: 5000,
    MAX_DOM_DEPTH: 50,
    MAX_LINKS: 500,
};

async function parseHtmlFormat(buffer, metadata = {}, options = {}) {
    if (!Buffer.isBuffer(buffer) && typeof buffer !== 'string') {
        throw new KosParserError('KOS_PARSE_INVALID_INPUT_TYPE', 'HTML content must be a Buffer or String.');
    }

    const htmlString = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
    if (!htmlString.trim()) {
        throw new KosParserError('KOS_PARSE_EMPTY_SOURCE', 'HTML source is empty.');
    }

    const warnings = [];
    const transformations = [];
    const capabilityReasons = [];

    let $;
    try {
        $ = cheerio.load(htmlString, {
            xmlMode: false,
            decodeEntities: true,
        });
    } catch (err) {
        throw new KosParserError('KOS_PARSE_CORRUPTED_CONTAINER', `Failed to parse HTML structure: ${err.message}`);
    }

    // Exclude non-user script/style elements from canonical text
    const scriptCount = $('script, style, noscript, template, svg').length;
    if (scriptCount > 0) {
        $('script, style, noscript, template, svg').remove();
        transformations.push({
            code: 'html_script_elements_excluded',
            adapter: ADAPTER_NAME,
            adapterVersion: ADAPTER_VERSION,
            count: scriptCount,
            affectsCanonicalText: true,
        });
        warnings.push({
            code: 'HTML_SCRIPT_ELEMENTS_EXCLUDED',
            count: scriptCount,
            message: `${scriptCount} non-user script/style/svg element(s) were excluded from canonical text.`,
        });
        // Note: Expected script exclusion logs transformation without downgrading parserCapability
    }

    const links = [];
    $('a[href]').each((i, el) => {
        if (links.length >= HTML_LIMITS.MAX_LINKS) return;
        const href = $(el).attr('href');
        const rel = $(el).attr('rel') || null;
        const text = $(el).text().trim();
        if (href) {
            links.push({
                text,
                href,
                rel,
                location: { nodeIndex: i + 1 },
            });
        }
    });

    const structuralUnits = [];
    let canonicalText = '';
    let nodeCounter = 0;
    const bodyEl = $('body').length ? $('body') : $.root();

    function traverse(element, ancestorIndexes = [], depth = 1) {
        if (depth > HTML_LIMITS.MAX_DOM_DEPTH) {
            warnings.push({
                code: 'HTML_MAX_DEPTH_EXCEEDED',
                message: `DOM depth exceeded limit of ${HTML_LIMITS.MAX_DOM_DEPTH}.`,
            });
            capabilityReasons.push('max_dom_depth_exceeded');
            return;
        }

        element.children().each((idx, child) => {
            if (nodeCounter >= HTML_LIMITS.MAX_DOM_NODES) return;
            const $child = $(child);
            const tagName = child.name ? child.name.toLowerCase() : '';

            if (!tagName) return;

            nodeCounter++;
            const currentNodeIndex = nodeCounter;
            const nodeAncestors = [...ancestorIndexes, currentNodeIndex];
            const nodeText = $child.text().trim();

            if (!nodeText) return;

            const isHeading = /^h[1-6]$/.test(tagName);
            if (isHeading || tagName === 'p' || tagName === 'li' || tagName === 'tr') {
                if (canonicalText.length > 0) canonicalText += '\n\n';
                const contentStartUtf16 = canonicalText.length;

                const textToAdd = isHeading ? `# ${nodeText}` : nodeText;
                canonicalText += textToAdd;
                const contentEndUtf16 = canonicalText.length;

                const unitId = `html_node_${String(structuralUnits.length + 1).padStart(5, '0')}`;
                structuralUnits.push({
                    id: unitId,
                    tagName,
                    text: textToAdd,
                    range: createRange({
                        utf16Start: contentStartUtf16,
                        utf16End: contentEndUtf16,
                        utf8ByteStart: Buffer.byteLength(canonicalText.slice(0, contentStartUtf16), 'utf8'),
                        utf8ByteEnd: Buffer.byteLength(canonicalText.slice(0, contentEndUtf16), 'utf8'),
                    }),
                    htmlLocation: {
                        nodeIndex: currentNodeIndex,
                        nodeType: 'element',
                        tagName,
                        ancestorIndexes: nodeAncestors,
                        sourceLocationStatus: 'not_available',
                        sourceLine: null,
                        sourceColumn: null,
                    },
                });
            } else {
                traverse($child, nodeAncestors, depth + 1);
            }
        });
    }

    traverse(bodyEl);

    if (!canonicalText.trim()) {
        canonicalText = $.text().replace(/\s+/g, ' ').trim();
    }

    const suspiciousResult = detectSuspiciousContent(canonicalText);
    const sourceChecksum = require('crypto').createHash('sha256').update(buffer).digest('hex');

    const capability = capabilityReasons.length > 0 ? 'partial' : 'full';

    return createParsedDocument({
        sourceChecksum,
        sourceMimeType: metadata.mimeType || 'text/html',
        sourceByteLength: Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(htmlString, 'utf8'),
        rawText: htmlString,
        canonicalText,
        sections: [
            {
                id: 'sec_0',
                type: 'preamble',
                headingText: null,
                bodyText: canonicalText,
                sourceText: canonicalText,
                range: createRange({
                    utf16Start: 0,
                    utf16End: canonicalText.length,
                    utf8ByteStart: 0,
                    utf8ByteEnd: Buffer.byteLength(canonicalText, 'utf8'),
                }),
            },
        ],
        suspiciousContent: suspiciousResult.findings,
        transformations,
        warnings: [...warnings, ...suspiciousResult.warnings],
        parserCapability: capability,
        parsedAt: options.now ? options.now().toISOString() : new Date().toISOString(),
        metadata: {
            ...metadata,
            linksCount: links.length,
            capabilityReasons,
        },
        structuralUnits,
        formatMetadata: {
            links,
            adapterName: ADAPTER_NAME,
            adapterVersion: ADAPTER_VERSION,
        },
    });
}

module.exports = {
    parseHtmlFormat,
    ADAPTER_NAME,
    ADAPTER_VERSION,
};

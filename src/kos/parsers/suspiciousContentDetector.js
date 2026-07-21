'use strict';

/**
 * WINE AI KOS - Suspicious Content Detector Stage (Step 2A Refined)
 * Detects potential prompt injection or system override instructions without deleting text.
 * Calculates exact UTF-16 code unit and UTF-8 byte offsets.
 * Enforces resource limits (MAX_SUSPICIOUS_MARKERS).
 */

const { PARSER_LIMITS, createRange } = require('./parserContracts');

const SUSPICIOUS_PATTERNS = [
    { name: 'system_bracket_tag', pattern: /<<<\s*system\s*>>>/gi, severity: 'high' },
    { name: 'system_prompt_header', pattern: /\[\s*system_prompt\s*\]/gi, severity: 'high' },
    { name: 'ignore_instructions', pattern: /ignore\s+previous\s+instructions/gi, severity: 'high' },
    { name: 'forget_prior_instructions', pattern: /forget\s+all\s+prior\s+instructions/gi, severity: 'high' },
    { name: 'script_tag', pattern: /<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, severity: 'warning' },
    { name: 'javascript_uri', pattern: /javascript\s*:/gi, severity: 'warning' },
];

function detectSuspiciousContent(canonicalText, codeBlockRanges = []) {
    const findings = [];
    const warnings = [];

    for (const rule of SUSPICIOUS_PATTERNS) {
        if (findings.length >= PARSER_LIMITS.MAX_SUSPICIOUS_MARKERS) {
            warnings.push({
                code: 'KOS_PARSE_TOO_MANY_SUSPICIOUS_MARKERS',
                message: `Suspicious marker limit of ${PARSER_LIMITS.MAX_SUSPICIOUS_MARKERS} reached. Truncating further scans.`,
            });
            break;
        }

        rule.pattern.lastIndex = 0;
        let match;
        while ((match = rule.pattern.exec(canonicalText)) !== null) {
            if (findings.length >= PARSER_LIMITS.MAX_SUSPICIOUS_MARKERS) {
                warnings.push({
                    code: 'KOS_PARSE_TOO_MANY_SUSPICIOUS_MARKERS',
                    message: `Suspicious marker limit of ${PARSER_LIMITS.MAX_SUSPICIOUS_MARKERS} reached. Truncating further scans.`,
                });
                break;
            }

            const utf16Start = match.index;
            const utf16End = match.index + match[0].length;

            const isInsideCodeBlock = codeBlockRanges.some(
                (cb) => utf16Start >= cb.utf16Start && utf16End <= cb.utf16End
            );

            const prefixText = canonicalText.slice(0, utf16Start);
            const utf8ByteStart = Buffer.byteLength(prefixText, 'utf8');
            const utf8ByteEnd = utf8ByteStart + Buffer.byteLength(match[0], 'utf8');

            findings.push({
                type: 'potential_instruction',
                pattern: rule.name,
                severity: isInsideCodeBlock ? 'info' : rule.severity,
                isInsideCodeBlock,
                text: match[0],
                range: createRange({ utf16Start, utf16End, utf8ByteStart, utf8ByteEnd }),
            });
        }
    }

    return {
        findings,
        warnings,
    };
}

module.exports = {
    detectSuspiciousContent,
};

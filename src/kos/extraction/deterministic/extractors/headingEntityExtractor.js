'use strict';

/**
 * WINE AI KOS - Heading Entity Deterministic Extractor (Step 3B Refined Boundary)
 *
 * Scopes wine entity name candidates from heading structural units.
 * Produces pure EvidenceDrafts without source identity.
 */

const { buildProvisionalKey } = require('../context/headingContext');
const { createCandidateDraft } = require('../../contracts/factCandidate');
const { createEvidenceDraft } = require('../../contracts/evidence');

const EXTRACTOR_NAME = 'kos-heading-entity-extractor';
const EXTRACTOR_VERSION = '1.0.0';

const CONFIDENCE_HEAVY_HEADING = Object.freeze({
    score: 0.88,
    method: 'deterministic_pattern',
    factors: Object.freeze([
        { code: 'heading_text_structure', contribution: 0.58 },
        { code: 'value_matches_field_policy', contribution: 0.30 },
    ]),
});

function extractHeadingEntityNames(parsedDocument, options = {}) {
    const drafts = [];
    const warnings = [];

    if (!parsedDocument || !Array.isArray(parsedDocument.structuralUnits)) {
        return { drafts, warnings };
    }

    const units = parsedDocument.structuralUnits;

    for (let idx = 0; idx < units.length; idx++) {
        const unit = units[idx];
        if (!unit || !unit.text) continue;

        if (unit.text.startsWith('# ') || unit.text.startsWith('## ')) {
            const rawName = unit.text.replace(/^#{1,6}\s*/, '').trim();
            if (!rawName || rawName.length < 3) continue;

            const provisionalKey = buildProvisionalKey(rawName);
            const entityRef = {
                kind: 'provisional',
                provisionalKey,
                displayName: rawName,
            };

            const evidenceDraft = createEvidenceDraft({
                evidenceType: 'heading_context',
                spans: [{
                    quote: rawName,
                    range: { representation: 'canonical-v1', utf16Start: unit.range.utf16Start + (unit.text.length - rawName.length), utf16End: unit.range.utf16End },
                    structuralUnitIds: [unit.id],
                }],
            });

            const draft = createCandidateDraft({
                entityType: 'wine',
                entityRef,
                fieldPath: 'wine.name',
                rawValue: rawName,
                valueType: 'string',
                evidenceDrafts: [evidenceDraft],
                confidence: CONFIDENCE_HEAVY_HEADING,
                extractor: { name: EXTRACTOR_NAME, version: EXTRACTOR_VERSION },
            });

            drafts.push(draft);
        }
    }

    return { drafts, warnings };
}

module.exports = {
    EXTRACTOR_NAME,
    EXTRACTOR_VERSION,
    CONFIDENCE_HEAVY_HEADING,
    extractHeadingEntityNames,
};

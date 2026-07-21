'use strict';

/**
 * WINE AI KOS - Heading Context & Provisional Key Builder (Step 3B Production)
 *
 * Tracks nearest heading context for scoping provisional wine entities and builds stable provisional keys.
 */

function buildProvisionalKey(displayName) {
    if (!displayName || typeof displayName !== 'string') {
        return 'provisional-entity';
    }

    const nfc = displayName.normalize('NFC').trim().toLowerCase();
    // Strip non-alphanumeric chars safely while preserving Unicode characters
    const clean = nfc
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    return clean || 'provisional-entity';
}

function parseHeadingLevel(headingText) {
    if (!headingText || typeof headingText !== 'string') return 1;
    const match = headingText.match(/^(#{1,6})\s/);
    if (match) {
        return match[1].length;
    }
    return 1;
}

function findNearestHeadingContext(structuralUnits = [], currentUnitIndex = 0, options = {}) {
    const maxDistance = options.maxDistance || 15;
    if (!Array.isArray(structuralUnits) || currentUnitIndex < 0 || currentUnitIndex >= structuralUnits.length) {
        return null;
    }

    let nearestHeading = null;
    let headingLevel = 99;

    for (let i = currentUnitIndex; i >= 0 && (currentUnitIndex - i) <= maxDistance; i--) {
        const unit = structuralUnits[i];
        if (!unit || !unit.text) continue;

        const isHeading = unit.text.startsWith('# ') || unit.text.startsWith('## ') || unit.text.startsWith('### ');
        if (isHeading) {
            const currentLevel = parseHeadingLevel(unit.text);
            if (currentLevel <= headingLevel) {
                const headingClean = unit.text.replace(/^#{1,6}\s*/, '').trim();
                nearestHeading = {
                    unitId: unit.id,
                    headingText: headingClean,
                    level: currentLevel,
                    provisionalKey: buildProvisionalKey(headingClean),
                    unitIndex: i,
                };
                headingLevel = currentLevel;
            }
            break; // Stop at first nearest heading higher/equal in hierarchy
        }
    }

    return nearestHeading;
}

module.exports = {
    buildProvisionalKey,
    parseHeadingLevel,
    findNearestHeadingContext,
};

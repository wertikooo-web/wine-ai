'use strict';

/**
 * Wine.md Conflict Resolver — resolves conflicts between wine.md and other sources.
 * wine.md is the primary partner source (priority 100) and wins for most fields.
 */

// Source priority levels (higher = more important)
const SOURCE_PRIORITY = {
    primary_partner_source: 100,  // wine.md
    official_website: 80,         // Official winery websites
    industry_portal: 60,          // ONVV, industry registries
    government: 60,               // Government sources
    media: 40,                    // News, articles
    catalog: 40,                  // Directories
    other: 20,                    // General web
    upload: 10,                   // User uploads
};

// Fields where wine.md always wins
const WINE_MD_ALWAYS_WINS = [
    'price',
    'availability',
    'phone',
    'email',
    'address',
    'website',
    'social_links',
    'working_hours',
    'product_url',
    'image',
];

// Fields where conflict goes to review
const CONFLICT_REQUIRES_REVIEW = [
    'grape_varieties',
    'wine_type',
    'color',
    'sweetness',
    'alcohol',
    'region',
    'volume',
    'serving_temperature',
    'description',
    'tasting_notes',
    'pairing',
];

/**
 * Resolve conflict between two facts from different sources.
 * @param {Object} existingFact - Current fact in database
 * @param {Object} newFact - New fact from incoming source
 * @returns {{ action: string, reason: string, resolved_value?: any }}
 */
function resolveConflict(existingFact, newFact) {
    const existingPriority = SOURCE_PRIORITY[existingFact.source_type] || 0;
    const newPriority = SOURCE_PRIORITY[newFact.source_type] || 0;

    // Same source priority — compare by trust level
    if (existingPriority === newPriority) {
        const existingTrust = existingFact.trust_level || 'C';
        const newTrust = newFact.trust_level || 'C';
        if (newTrust < existingTrust) {
            return { action: 'replace', reason: 'higher_trust_level' };
        }
        return { action: 'keep', reason: 'same_or_lower_trust' };
    }

    // New source has higher priority
    if (newPriority > existingPriority) {
        // Check if this is a wine.md source
        const isNewWineMd = newFact.source_type === 'primary_partner_source';

        if (isNewWineMd && WINE_MD_ALWAYS_WINS.includes(newFact.field_name)) {
            return { action: 'replace', reason: 'wine_md_priority' };
        }

        // For fields requiring review, flag conflict
        if (CONFLICT_REQUIRES_REVIEW.includes(newFact.field_name)) {
            return { action: 'flag_review', reason: 'source_priority_conflict' };
        }

        return { action: 'replace', reason: 'higher_source_priority' };
    }

    // Existing source has higher priority — keep existing
    return { action: 'keep', reason: 'existing_source_higher_priority' };
}

/**
 * Check if a fact from wine.md should be immediately active.
 * @param {Object} fact - The fact to check
 * @returns {boolean}
 */
function shouldActivateWineMdFact(fact) {
    // Must have source_url
    if (!fact.source_url) return false;

    // Must have passed basic validation
    if (!fact.normalized_value || fact.normalized_value.length < 1) return false;

    // Must not have explicit conflict
    if (fact.conflict_state === 'detected') return false;

    // Must be from wine.md
    if (fact.source_type !== 'primary_partner_source') return false;

    return true;
}

/**
 * Get conflict resolution strategy for a field.
 * @param {string} fieldName - The field name
 * @param {string} sourceType - The source type
 * @returns {{ strategy: string, requires_review: boolean }}
 */
function getConflictStrategy(fieldName, sourceType) {
    const isWineMd = sourceType === 'primary_partner_source';

    // Wine.md always wins for these fields
    if (isWineMd && WINE_MD_ALWAYS_WINS.includes(fieldName)) {
        return { strategy: 'wine_md_wins', requires_review: false };
    }

    // Fields requiring review for conflicts
    if (CONFLICT_REQUIRES_REVIEW.includes(fieldName)) {
        return { strategy: 'flag_review', requires_review: true };
    }

    // Default: higher priority wins
    return { strategy: 'priority_wins', requires_review: false };
}

module.exports = {
    resolveConflict,
    shouldActivateWineMdFact,
    getConflictStrategy,
    SOURCE_PRIORITY,
    WINE_MD_ALWAYS_WINS,
    CONFLICT_REQUIRES_REVIEW,
};

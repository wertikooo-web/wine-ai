'use strict';

/**
 * WINE AI KOS - Field Authority & Freshness Policies
 * Defines source precedence, freshness decay, and approval policies for domain fields.
 */

const SOURCE_AUTHORITY = {
    official_passport: 1.0,
    official_tech_sheet: 0.95,
    official_website: 0.90,
    owner_interview: 0.85,
    official_competition_record: 0.85,
    media_publication: 0.60,
    aggregator: 0.30,
    unverified: 0.10,
};

const FIELD_POLICIES = {
    // 1. Technical Wine Parameters (Require high accuracy)
    'wine.alcohol_percentage': {
        preferredSources: ['official_tech_sheet', 'official_passport', 'official_website'],
        maximumAgeDays: 365,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
    'wine.residual_sugar_g_l': {
        preferredSources: ['official_tech_sheet', 'official_passport', 'official_website'],
        maximumAgeDays: 365,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
    'wine.grape_composition': {
        preferredSources: ['official_passport', 'official_tech_sheet', 'official_website'],
        maximumAgeDays: 730,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },

    // 2. Commercial Data (Fast decay)
    'commercial.price': {
        preferredSources: ['official_website', 'official_price_list'],
        maximumAgeDays: 30,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
    'commercial.availability': {
        preferredSources: ['official_website', 'official_price_list'],
        maximumAgeDays: 7,
        requiresHumanApproval: false,
        allowAutomaticReplacement: true,
    },

    // 3. Operational Data (Medium decay)
    'operational.opening_hours': {
        preferredSources: ['official_website', 'official_social'],
        maximumAgeDays: 90,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
    'operational.contact_phone': {
        preferredSources: ['official_website', 'official_passport'],
        maximumAgeDays: 180,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },

    // 4. History & Culture (Stable)
    'winery.founded_year': {
        preferredSources: ['official_passport', 'owner_interview', 'official_website'],
        maximumAgeDays: 3650,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
    'winery.history': {
        preferredSources: ['owner_interview', 'official_website', 'official_passport'],
        maximumAgeDays: 1825,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },

    // Default fallback policy
    default: {
        preferredSources: ['official_website', 'official_passport'],
        maximumAgeDays: 365,
        requiresHumanApproval: true,
        allowAutomaticReplacement: false,
    },
};

function getFieldPolicy(fieldKey) {
    return FIELD_POLICIES[fieldKey] || FIELD_POLICIES.default;
}

function calculateFreshnessScore(extractedAtDate, maximumAgeDays = 365) {
    if (!extractedAtDate) return 0.5;
    const dateObj = new Date(extractedAtDate);
    if (isNaN(dateObj.getTime())) return 0.5;

    const ageMs = Date.now() - dateObj.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays <= 0) return 1.0;
    if (ageDays >= maximumAgeDays) return 0.1;

    const score = 1.0 - (ageDays / maximumAgeDays) * 0.9;
    return Number(Math.max(0.1, Math.min(1.0, score)).toFixed(2));
}

module.exports = {
    SOURCE_AUTHORITY,
    FIELD_POLICIES,
    getFieldPolicy,
    calculateFreshnessScore,
};

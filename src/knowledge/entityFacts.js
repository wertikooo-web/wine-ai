'use strict';

// Structured entity fact store — the single source of truth for fast scalar
// facts (address, phone, hours, website, etc.) that should NOT go through
// the general semantic chunk retrieval pipeline.
//
// Design principles:
// - Facts are stored per entity_id + fact_type with source provenance.
// - Source hierarchy determines which fact wins when conflicts exist.
// - TTL is fact-type-specific (hours expire fast, static descriptions slow).
// - Every fact carries its source URL, type, confidence, and fetched_at.
// - No LLM calls needed for simple scalar lookups.

const fs = require('fs');
const path = require('path');

const FACTS_DIR = path.join(__dirname, '..', '..', 'knowledge', 'entity-facts');

// Source hierarchy: lower number = higher trust
const SOURCE_HIERARCHY = {
    manually_verified: 1,
    official_website: 2,
    maps_place_provider: 3,
    official_industry: 4,
    approved_marketplace: 5,
    general_web: 6,
};

// TTL per fact type in milliseconds
const FACT_TTL = {
    address: 30 * 24 * 60 * 60 * 1000,       // 30 days
    phone: 30 * 24 * 60 * 60 * 1000,          // 30 days
    email: 30 * 24 * 60 * 60 * 1000,          // 30 days
    opening_hours: 7 * 24 * 60 * 60 * 1000,   // 7 days
    website: 90 * 24 * 60 * 60 * 1000,        // 90 days
    booking_url: 90 * 24 * 60 * 60 * 1000,    // 90 days
    purchase_url: 30 * 24 * 60 * 60 * 1000,   // 30 days
    description: 180 * 24 * 60 * 60 * 1000,   // 180 days
    coordinates: 90 * 24 * 60 * 60 * 1000,    // 90 days
    latitude: 90 * 24 * 60 * 60 * 1000,
    longitude: 90 * 24 * 60 * 60 * 1000,
    region: 180 * 24 * 60 * 60 * 1000,        // 180 days
    country: 365 * 24 * 60 * 60 * 1000,       // 365 days
    city: 180 * 24 * 60 * 60 * 1000,          // 180 days
    entity_type: 365 * 24 * 60 * 60 * 1000,
    short_description: 180 * 24 * 60 * 60 * 1000,
    // Wine-specific
    grapes: 180 * 24 * 60 * 60 * 1000,
    alcohol: 180 * 24 * 60 * 60 * 1000,
    vintage: 365 * 24 * 60 * 60 * 1000,
    tasting_notes: 180 * 24 * 60 * 60 * 1000,
    serving_temperature: 180 * 24 * 60 * 60 * 1000,
    pairing: 180 * 24 * 60 * 60 * 1000,
    awards: 90 * 24 * 60 * 60 * 1000,
    price: 60 * 60 * 1000,                    // 1 hour (prices change fast)
    availability: 30 * 60 * 1000,             // 30 minutes
};

const DEFAULT_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days fallback

const _factStore = new Map(); // entity_id -> Map<fact_type, FactEntry[]>

function _factsFilePath(entityId) {
    const safe = entityId.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(FACTS_DIR, `${safe}.json`);
}

function _loadFacts(entityId) {
    if (_factStore.has(entityId)) return _factStore.get(entityId);
    const filePath = _factsFilePath(entityId);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(raw);
            const typeMap = new Map();
            for (const [factType, entries] of Object.entries(data)) {
                typeMap.set(factType, entries);
            }
            _factStore.set(entityId, typeMap);
            return typeMap;
        }
    } catch { /* corrupt file → start fresh */ }
    const empty = new Map();
    _factStore.set(entityId, empty);
    return empty;
}

function _saveFacts(entityId, typeMap) {
    if (!fs.existsSync(FACTS_DIR)) {
        fs.mkdirSync(FACTS_DIR, { recursive: true });
    }
    const obj = {};
    for (const [k, v] of typeMap) {
        obj[k] = v;
    }
    const filePath = _factsFilePath(entityId);
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Store a structured fact for an entity.
 * Conflicting facts from lower-trust sources are rejected.
 * Conflicting facts from equal-trust sources: newer fetched_at wins.
 */
function storeFact(entityId, {
    factType,
    value,
    sourceUrl = null,
    sourceType = 'manually_verified',
    confidence = 'high',
    fetchedAt = new Date().toISOString(),
    verifiedAt = null,
    extractionMethod = 'manual',
    rawEvidence = null,
} = {}) {
    if (!entityId || !factType || value === undefined || value === null || value === '') return false;

    const typeMap = _loadFacts(entityId);
    const existing = typeMap.get(factType) || [];

    const newFact = {
        entity_id: entityId,
        fact_type: factType,
        value: String(value).trim(),
        source_url: sourceUrl,
        source_type: sourceType,
        source_priority: SOURCE_HIERARCHY[sourceType] || 99,
        confidence,
        fetched_at: fetchedAt,
        verified_at: verifiedAt,
        expires_at: _computeExpiry(factType, fetchedAt),
        extraction_method: extractionMethod,
        raw_evidence: rawEvidence,
    };

    // Find existing fact from same source
    const sameSourceIdx = existing.findIndex(
        (f) => f.source_type === sourceType && f.source_url === sourceUrl
    );

    if (sameSourceIdx >= 0) {
        // Update existing fact from same source
        existing[sameSourceIdx] = newFact;
    } else {
        // Check if new fact should override existing ones based on source hierarchy
        const higherTrustExisting = existing.some(
            (f) => (f.source_priority || 99) < newFact.source_priority
        );
        if (!higherTrustExisting) {
            // Remove lower-trust facts and add new one
            const filtered = existing.filter(
                (f) => (f.source_priority || 99) <= newFact.source_priority
            );
            filtered.push(newFact);
            typeMap.set(factType, filtered);
        } else {
            // Add as supplementary fact (lower trust, won't be returned by default)
            existing.push(newFact);
            typeMap.set(factType, existing);
        }
    }

    if (!typeMap.has(factType)) {
        typeMap.set(factType, sameSourceIdx >= 0 ? existing : [newFact]);
    }

    _saveFacts(entityId, typeMap);
    return true;
}

/**
 * Get the best fact for a given entity + fact type.
 * Returns the highest-trust, non-expired fact.
 */
function getFact(entityId, factType) {
    const typeMap = _loadFacts(entityId);
    const entries = typeMap.get(factType) || [];
    const now = Date.now();

    // Filter out expired facts, then sort by source priority (lowest = best)
    const valid = entries
        .filter((f) => {
            if (!f.expires_at) return true;
            return new Date(f.expires_at).getTime() > now;
        })
        .sort((a, b) => (a.source_priority || 99) - (b.source_priority || 99));

    return valid[0] || null;
}

/**
 * Get multiple facts for an entity in one call (fast path for structured queries).
 */
function getFacts(entityId, factTypes) {
    const result = {};
    for (const ft of factTypes) {
        result[ft] = getFact(entityId, ft);
    }
    return result;
}

/**
 * Get all facts for an entity (for full profile).
 */
function getAllFacts(entityId) {
    const typeMap = _loadFacts(entityId);
    const now = Date.now();
    const result = {};
    for (const [factType, entries] of typeMap) {
        const valid = entries
            .filter((f) => !f.expires_at || new Date(f.expires_at).getTime() > now)
            .sort((a, b) => (a.source_priority || 99) - (b.source_priority || 99));
        if (valid.length > 0) {
            result[factType] = valid[0];
        }
    }
    return result;
}

/**
 * Check if a specific fact exists and is not expired.
 */
function hasFreshFact(entityId, factType) {
    const fact = getFact(entityId, factType);
    return fact !== null;
}

/**
 * Get the expiry date for a fact type.
 */
function _computeExpiry(factType, fetchedAt) {
    const ttl = FACT_TTL[factType] || DEFAULT_TTL;
    const fetched = new Date(fetchedAt).getTime();
    return new Date(fetched + ttl).toISOString();
}

/**
 * List all entity IDs that have facts stored.
 */
function listEntities() {
    if (!fs.existsSync(FACTS_DIR)) return [];
    return fs.readdirSync(FACTS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''));
}

/**
 * Invalidate a specific fact type for an entity.
 */
function invalidateFact(entityId, factType) {
    const typeMap = _loadFacts(entityId);
    if (typeMap.has(factType)) {
        typeMap.delete(factType);
        _saveFacts(entityId, typeMap);
    }
}

module.exports = {
    storeFact,
    getFact,
    getFacts,
    getAllFacts,
    hasFreshFact,
    listEntities,
    invalidateFact,
    SOURCE_HIERARCHY,
    FACT_TTL,
};

'use strict';

// Claim-level provenance contract for the knowledge orchestrator.
//
// Every retrieved evidence item is classified into one of six claim kinds
// (the "answer audit" vocabulary from
// docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md §6), carrying its
// source, confidence, and checked/verified timestamps so a consumer can see,
// for every single claim, WHERE it came from and HOW TRUSTED it is -- without
// the model narrating any internal retrieval or web-search process.

const CLAIM_KINDS = Object.freeze({
    VERIFIED_FACT: 'verified_fact',
    LIVE_CATALOG_FACT: 'live_catalog_fact',
    DOCUMENT_SUPPORTED_FACT: 'document_supported_fact',
    CURRENT_WEB_FACT: 'current_web_fact',
    AI_INFERENCE: 'ai_inference',
    UNRESOLVED_OR_CONFLICTING: 'unresolved_or_conflicting',
});

const LEVEL_TO_CLAIM_KIND = Object.freeze({
    canonical: CLAIM_KINDS.VERIFIED_FACT,
    catalog: CLAIM_KINDS.LIVE_CATALOG_FACT,
    documents: CLAIM_KINDS.DOCUMENT_SUPPORTED_FACT,
    web: CLAIM_KINDS.CURRENT_WEB_FACT,
});

// Rank used when presenting claims strongest-first (also the order in which a
// confident narrator should prefer them). Lower = stronger.
const CLAIM_KIND_RANK = Object.freeze({
    verified_fact: 0,
    live_catalog_fact: 1,
    document_supported_fact: 2,
    current_web_fact: 3,
    ai_inference: 4,
    unresolved_or_conflicting: 5,
});

// Same volatile field list as layeredRouter.detectConflicts -- kept here so
// conflict-key computation is identical and a claim marked "unresolved" always
// corresponds 1:1 to a detected conflict.
const VOLATILE_FIELDS = Object.freeze(['price', 'availability', 'stock_quantity', 'opening_hours', 'schedule']);

function claimKindForItem(item) {
    if (!item || !item.level) return null;
    return LEVEL_TO_CLAIM_KIND[item.level] || null;
}

function sourceForItem(item) {
    const level = item.level;
    if (level === 'canonical') {
        return {
            type: item.source_type || 'canonical',
            title: item.title || null,
            url: item.source || null,
            verified_at: item.provenance?.verified_at || null,
            expires_at: item.provenance?.expires_at || null,
        };
    }
    if (level === 'catalog') {
        return {
            type: item.source_type || 'catalog',
            title: item.title || null,
            url: item.catalog?.product_url || item.source || null,
            checked_at: item.catalog?.last_synced_at || null,
        };
    }
    if (level === 'documents') {
        return {
            type: item.source_type || 'document',
            title: item.title || null,
            url: item.source || null,
            document_page: item.provenance?.source_file || null,
            chunk_id: item.provenance?.chunk_id || null,
            language: item.provenance?.language || null,
        };
    }
    if (level === 'web') {
        return {
            type: item.source_type || 'general_web',
            title: item.title || null,
            url: item.source || null,
            provider: item.provenance?.provider || null,
        };
    }
    return {
        type: item.source_type || level || null,
        title: item.title || null,
        url: item.source || null,
    };
}

// Dynamic data (price/stock/hours/schedule) is only ever as good as the last
// sync or fetch -- the claim carries that timestamp so consumers can state
// "сейчас" truthfully or flag it as stale.
function freshnessForItem(item) {
    const level = item.level;
    if (level === 'catalog') {
        const dynamic = VOLATILE_FIELDS.some((field) => item.catalog?.[field] != null);
        return {
            dynamic,
            fields: dynamic ? VOLATILE_FIELDS.filter((field) => item.catalog?.[field] != null) : [],
            as_of: item.catalog?.last_synced_at || null,
        };
    }
    if (level === 'web') {
        return { dynamic: true, fields: [], as_of: item._checked_at || null };
    }
    if (level === 'canonical') {
        return { dynamic: false, as_of: item.provenance?.verified_at || null };
    }
    return { dynamic: false, as_of: null };
}

function claimFromItem(item, index, { conflictKey = null } = {}) {
    return {
        id: `claim_${index + 1}`,
        claim: String(item.text || '').slice(0, 500),
        kind: claimKindForItem(item),
        level: item.level || null,
        confidence: item.confidence || null,
        entity_id: item.provenance?.entity_id || item.catalog?.wine_entity_id || null,
        source: sourceForItem(item),
        freshness: freshnessForItem(item),
        conflict: null,
        // Structured knowledge-graph evidence (Phase 4): relation edges carry
        // their structure through the claim so an audit/admin surface can show
        // that a claim came from a typed entity_relation, not a text chunk.
        structured: item.structured_kind === 'entity_relation'
            ? {
                  kind: 'entity_relation',
                  ...(item.relation || {}),
                  relation_id: item.provenance?.relation_id || null,
              }
            : null,
    };
}

function buildClaimsFromEvidence(evidence) {
    if (!Array.isArray(evidence)) return [];
    return evidence.map((item, index) => {
        const claim = claimFromItem(item, index);
        claim._conflict_key = conflictKeyForItem(item);
        return claim;
    });
}

// Reproduces layeredRouter.detectConflicts()'s key computation for a single
// item, so a claim can be matched against the conflict set it actually
// belongs to. Returns null for items that cannot participate in a conflict.
function conflictKeyForItem(item) {
    if (!item) return null;
    if (item.level === 'canonical' && item.provenance?.entity_id) {
        const field = String(item.text || '').split(':')[0].trim();
        return `${item.provenance.entity_id}:${field}`;
    }
    if (item.level === 'catalog' && item.catalog) {
        for (const field of VOLATILE_FIELDS) {
            if (item.catalog[field] != null) {
                return `${item.catalog.external_id || item.title}:${field}`;
            }
        }
    }
    return null;
}

// Marks claims that participate in a detected conflict as
// UNRESOLVED_OR_CONFLICTING. The conflicting values stay attached -- the
// claim is never merged into a confident single value; the narrator must
// present the disagreement instead.
function annotateConflicts(claims, conflicts) {
    if (!Array.isArray(claims) || !Array.isArray(conflicts) || !conflicts.length) return claims;
    const byKey = new Map();
    for (const conflict of conflicts) byKey.set(conflict.key, conflict);
    return claims.map((claim) => {
        const key = claim._conflict_key;
        if (key && byKey.has(key)) {
            const conflict = byKey.get(key);
            return {
                ...claim,
                kind: CLAIM_KINDS.UNRESOLVED_OR_CONFLICTING,
                conflict: { key: conflict.key, values: conflict.values },
            };
        }
        return claim;
    });
}

// Net freshness summary for the whole claim set: is this answer about dynamic
// data, and when was the newest piece of evidence checked/synced?
function summarizeFreshness(claims, freshnessSensitive = false) {
    const dynamicClaims = (claims || []).filter((claim) => claim.freshness?.dynamic);
    let newestCheckedAt = null;
    for (const claim of claims || []) {
        const asOf = claim.freshness?.as_of || claim.source?.checked_at || claim.source?.verified_at;
        if (asOf && (!newestCheckedAt || new Date(asOf) > new Date(newestCheckedAt))) newestCheckedAt = asOf;
    }
    return {
        freshness_sensitive: freshnessSensitive === true,
        dynamic_fields_present: dynamicClaims.length > 0,
        newest_checked_at: newestCheckedAt,
        synced_through: newestCheckedAt,
    };
}

// Strongest-first ordering of claims (verified facts first, unresolved last).
function rankClaims(claims) {
    if (!Array.isArray(claims)) return [];
    return [...claims].sort((a, b) => {
        const ra = CLAIM_KIND_RANK[a.kind] ?? 5;
        const rb = CLAIM_KIND_RANK[b.kind] ?? 5;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
    });
}

module.exports = {
    CLAIM_KINDS,
    LEVEL_TO_CLAIM_KIND,
    VOLATILE_FIELDS,
    CLAIM_KIND_RANK,
    claimKindForItem,
    sourceForItem,
    freshnessForItem,
    claimFromItem,
    buildClaimsFromEvidence,
    conflictKeyForItem,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
};
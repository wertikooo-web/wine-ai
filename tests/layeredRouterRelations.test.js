'use strict';

// Phase 4 v1 router integration: entity-relation evidence in the layered
// knowledge router (src/knowledge/layeredRouter.js).
//
// The invariant under test: relation evidence is canonical-level structured
// truth that must outrank fuzzy canonical/fact matches for multi-condition
// questions (per the roadmap, "multi-condition queries work without relying
// only on semantic text similarity"). RouteKnowledge therefore runs the
// relations level first-class and merges it ahead of generic canonical hits.

const assert = require('assert');
const { LEVELS, routeKnowledge } = require('../src/knowledge/layeredRouter');

const canonical = (text = 'country: Moldova') => ({
    level: LEVELS.CANONICAL,
    text,
    title: 'cricova',
    source: 'https://official.example',
    confidence: 'verified',
    provenance: { entity_id: 'cricova' },
});

const relationItem = (predicate, objectValue, confidence = 'verified') => ({
    level: 'canonical',
    structured: true,
    structured_kind: 'entity_relation',
    text: `Cricova — ${predicate}: ${objectValue}`,
    title: 'Cricova',
    source: 'knowledge/source/cricova.md',
    source_type: 'relation',
    confidence,
    provenance: {
        entity_id: 'cricova',
        relation_id: 'rel_fix',
        predicate,
        object_id: null,
        object_type: 'wine',
        object_value: objectValue,
        validation_status: 'approved',
        verified_at: new Date().toISOString(),
    },
    relation: { subject_id: 'cricova', subject_type: 'winery', predicate, object_id: null, object_type: 'wine', object_value: objectValue },
});

function adapters({ relationItems = [], canonicalItems = [], documentItems = [], webItems = [] } = {}) {
    const calls = [];
    return {
        calls,
        value: {
            searchCanonical: async () => { calls.push('canonical'); return canonicalItems; },
            searchRelations: async () => { calls.push('relations'); return relationItems; },
            searchDocuments: async () => { calls.push('documents'); return documentItems; },
            searchInternet: async () => { calls.push('web'); return webItems; },
        },
    };
}

async function run() {
    // Relations level is consulted for every route alongside canonical.
    {
        const stub = adapters({});
        const result = await routeKnowledge('винодельни в Кодру', { adapters: stub.value, allowWeb: false });
        assert.ok(stub.calls.includes('relations'), 'relations level consulted');
        assert.ok(stub.calls.includes('canonical'), 'canonical still consulted');
    }

    // Relation evidence outranks generic canonical/fact evidence. Even if two
    // wineries match a region query, the relation edge (which winery is IN
    // that region) is what surfaces first in the merged evidence.
    {
        const stub = adapters({
            relationItems: [relationItem('located_in', 'Кодру')],
            canonicalItems: [canonical()],
        });
        const result = await routeKnowledge('винодельни в Кодру', { adapters: stub.value, allowWeb: false });
        assert.ok(result.evidence.length >= 2, 'both sources merged into evidence');
        assert.strictEqual(result.evidence[0].structured_kind, 'entity_relation',
            'relation evidence comes ahead of generic canonical');
        const relationIdx = result.evidence.findIndex((item) => item.structured_kind === 'entity_relation');
        const canonicalIdx = result.evidence.findIndex((item) => item.level === LEVELS.CANONICAL && !item.structured_kind);
        assert.ok(relationIdx !== -1 && (canonicalIdx === -1 || relationIdx < canonicalIdx),
            'relation evidence precedes canonical in merged output');
        assert.ok(result.used_levels.includes('canonical'), 'canonical remains a used level');
    }

    // Multi-condition question resolved purely by relations (no generic hits
    // needed): region + product type. The relations answer must be the reason
    // internal evidence is strong (no web fallback).
    {
        const stub = adapters({
            relationItems: [relationItem('produces', 'игристые вина')],
        });
        const result = await routeKnowledge('какие игристые вина делают в Кодру', { adapters: stub.value, allowWeb: true });
        assert.strictEqual(result.found, true, 'relations evidence makes the route found');
        assert.strictEqual(result.web_used, false, 'strong relations evidence prevents web fallback');
        assert.strictEqual(result.web_attempted, false, 'web not attempted on strong internal evidence');
        assert.ok(result.evidence.some((item) => item.structured && item.relation.predicate === 'produces'),
            'the produces relation is present in evidence');
    }

    // Weak/no relations + no other internal evidence still falls back to web
    // (relations returning [] must not break the existing fallback contract).
    {
        const stub = adapters({ webItems: [{
            level: LEVELS.WEB,
            text: 'General wine facts about Codru region.',
            title: 'Wine blog',
            source: 'https://blog.example/codru',
            source_type: 'general_web',
            confidence: 'medium',
        }] });
        const result = await routeKnowledge('что-то о неизвестном вине из Кодру', { adapters: stub.value });
        assert.ok(stub.calls.includes('relations'), 'relations consulted');
        assert.strictEqual(result.web_used, true, 'web fallback works when relations are empty');
    }

    return {};
}

module.exports = { run };
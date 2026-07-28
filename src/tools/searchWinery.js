'use strict';

const { loadIndex } = require('../knowledge/index');
const { search } = require('../knowledge/search');
const { resolveEntity, buildAliasContext } = require('../knowledge/entityResolver');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_winery',
    description: 'Look up information about a specific Moldovan winery or wine platform by name. Call this before describing a winery\'s history, wines, or location.',
    parameters: {
        type: 'OBJECT',
        properties: {
            name: { type: 'STRING', description: 'The winery name, as the user said it.' },
            region: { type: 'STRING', description: 'Optional region to narrow the search.' },
        },
        required: ['name'],
    },
};

const MAX_RESULTS = 6;

function searchByEntityId(index, entityId, region) {
    const candidates = index.chunks.filter((chunk) => (
        chunk.metadata.entity_id === entityId
        && chunk.metadata.enabled !== false
        && (!region || (chunk.metadata.region || '').toLowerCase().includes(region.toLowerCase()))
    ));
    if (candidates.length === 0) return null;
    const winery = candidates[0].metadata.winery || candidates[0].metadata.title;
    return {
        found: true,
        winery,
        region: candidates[0].metadata.region,
        results: candidates.slice(0, MAX_RESULTS).map((chunk) => ({
            text: chunk.text,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
        })),
    };
}

async function impl(args) {
    const name = requireNonEmptyString(args.name, 'name');
    const region = optionalString(args.region, 60);

    const index = loadIndex();
    const nameLower = name.toLowerCase();

    // Multi-entity: resolve all entities mentioned in the query
    const allMentions = [];
    const primaryResolved = resolveEntity(name);
    if (primaryResolved.found && primaryResolved.allMentions) {
        allMentions.push(...primaryResolved.allMentions);
    } else if (primaryResolved.found) {
        allMentions.push({ entityId: primaryResolved.entityId, canonicalName: primaryResolved.canonicalName, matchedAlias: primaryResolved.matchedAlias });
    }

    // If entity resolver matched, check for chunks
    if (primaryResolved.found) {
        const entityResult = searchByEntityId(index, primaryResolved.entityId, region);
        if (entityResult) {
            const aliasContext = buildAliasContext(primaryResolved);
            const results = [];
            if (aliasContext) {
                results.push({ text: aliasContext, source: 'entity_resolver', confidence: 'high' });
            }
            for (const r of entityResult.results) {
                if (results.length >= MAX_RESULTS) break;
                results.push(r);
            }
            return { ...entityResult, results };
        }
        // Entity resolved but no chunks → found: false (not a false positive)
        return { found: false, results: [], reason: 'entity_known_no_chunks', entity: primaryResolved.entityId };
    }

    // No entity match — only search for winery_profile doc_type
    const direct = index.chunks.filter((chunk) => (
        chunk.metadata.doc_type === 'winery_profile'
        && chunk.metadata.winery
        && chunk.metadata.winery.toLowerCase().includes(nameLower)
        && (!region || (chunk.metadata.region || '').toLowerCase().includes(region.toLowerCase()))
    ));

    if (direct.length > 0) {
        return {
            found: true,
            winery: direct[0].metadata.winery,
            region: direct[0].metadata.region,
            results: direct.slice(0, MAX_RESULTS).map((chunk) => ({
                text: chunk.text,
                source: chunk.metadata.source,
                confidence: chunk.metadata.confidence,
            })),
        };
    }

    // Last resort: keyword search — but only return found: true if we actually have content
    const { hits, entityContext } = await search(`${name} ${region}`.trim(), { limit: 3 });
    if (hits.length === 0) {
        return { found: false, results: [] };
    }

    // Only consider results as evidence if they have reasonable scores (not just noise)
    const evidenceHits = hits.filter((h) => h.score >= 3);
    if (evidenceHits.length === 0) {
        return { found: false, results: [] };
    }

    const results = [];
    if (entityContext) {
        results.push({ text: entityContext, source: 'entity_resolver', confidence: 'high' });
    }
    for (const { chunk } of evidenceHits) {
        if (results.length >= MAX_RESULTS) break;
        results.push({
            text: chunk.text,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
        });
    }

    return {
        found: true,
        winery: name,
        region: region || null,
        results,
    };
}

module.exports = { declaration, impl };

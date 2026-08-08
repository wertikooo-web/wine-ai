'use strict';

const { resolveActiveIndex } = require('../knowledge/search');
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

    const { index } = await resolveActiveIndex();
    const nameLower = name.toLowerCase();

    // Resolve with suggestions enabled for safe fuzzy matching
    const primaryResolved = resolveEntity(name, { includeSuggestions: true });

    // Multi-entity: resolve all entities mentioned in the query
    const allMentions = [];
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

    // Entity not found — check for medium-confidence suggestions
    if (primaryResolved.suggestions && primaryResolved.suggestions.length > 0) {
        return {
            found: false,
            results: [],
            reason: 'entity_suggested',
            suggestions: primaryResolved.suggestions,
            // The assistant should ask: "Did you mean <suggestion>?"
        };
    }

    // Unknown entity, no suggestions — fail-closed.
    // Do NOT fall back to keyword search for brand/winery-specific lookups.
    // The keyword fallback would return unrelated chunks from other wineries,
    // which is worse than honestly reporting "not found".
    // General topic queries should use search_wine_knowledge instead.
    return { found: false, results: [], reason: 'entity_not_found' };
}

module.exports = { declaration, impl };

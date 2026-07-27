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
        results: candidates.map((chunk) => ({
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

    const resolved = resolveEntity(name);

    if (resolved.found) {
        const entityResult = searchByEntityId(index, resolved.entityId, region);
        if (entityResult) {
            const aliasContext = buildAliasContext(resolved);
            const results = [];
            if (aliasContext) {
                results.push({ text: aliasContext, source: 'entity_resolver', confidence: 'high' });
            }
            for (const r of entityResult.results) {
                results.push(r);
            }
            return { ...entityResult, results };
        }
    }

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
            results: direct.map((chunk) => ({
                text: chunk.text,
                source: chunk.metadata.source,
                confidence: chunk.metadata.confidence,
            })),
        };
    }

    const { hits, entityContext } = await search(`${name} ${region}`.trim(), { limit: 3 });
    if (hits.length === 0) {
        return { found: false, results: [] };
    }

    const results = [];
    if (entityContext) {
        results.push({ text: entityContext, source: 'entity_resolver', confidence: 'high' });
    }
    for (const { chunk } of hits) {
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

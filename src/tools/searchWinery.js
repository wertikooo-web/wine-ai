'use strict';

const { loadIndex } = require('../knowledge/index');
const { search } = require('../knowledge/search');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_winery',
    description: 'Look up information about a specific Moldovan winery by name. Call this before describing a winery\'s history, wines, or location.',
    parameters: {
        type: 'OBJECT',
        properties: {
            name: { type: 'STRING', description: 'The winery name, as the user said it.' },
            region: { type: 'STRING', description: 'Optional region to narrow the search.' },
        },
        required: ['name'],
    },
};

async function impl(args) {
    const name = requireNonEmptyString(args.name, 'name');
    const region = optionalString(args.region, 60);

    const index = loadIndex();
    const nameLower = name.toLowerCase();
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

    // Fall back to full-text search in case the winery is mentioned in a
    // document that isn't itself tagged doc_type=winery_profile.
    const { hits } = search(`${name} ${region}`.trim(), { limit: 3 });
    if (hits.length === 0) {
        return { found: false, results: [] };
    }
    return {
        found: true,
        winery: name,
        region: region || null,
        results: hits.map(({ chunk }) => ({
            text: chunk.text,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
        })),
    };
}

module.exports = { declaration, impl };

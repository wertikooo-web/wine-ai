'use strict';

const { search } = require('../knowledge/search');
const { optionalString } = require('./toolHelpers');

const declaration = {
    name: 'get_wine_route_information',
    description: 'Get information about Moldovan wine tourism routes and cellar visits, optionally for a specific region. Call this before describing a wine tour or route.',
    parameters: {
        type: 'OBJECT',
        properties: {
            region: { type: 'STRING', description: 'Optional region or winery name to focus the route on.' },
        },
    },
};

async function impl(args) {
    const region = optionalString(args.region, 100);
    const query = region ? `винный маршрут ${region}` : 'винный маршрут туризм';
    const { hits } = search(query, { limit: 3 });

    if (hits.length === 0) {
        return { found: false, region: region || null, results: [] };
    }

    return {
        found: true,
        region: region || null,
        results: hits.map(({ chunk }) => ({
            text: chunk.text,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
        })),
    };
}

module.exports = { declaration, impl };

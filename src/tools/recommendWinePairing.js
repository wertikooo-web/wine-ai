'use strict';

const { search } = require('../knowledge/search');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'recommend_wine_pairing',
    description: 'Recommend a Moldovan wine to pair with a dish or occasion. Call this before recommending a specific wine for food pairing.',
    parameters: {
        type: 'OBJECT',
        properties: {
            dish: { type: 'STRING', description: 'The dish or type of food to pair, in the user\'s own words.' },
            occasion: { type: 'STRING', description: 'Optional occasion (e.g. celebration, casual dinner).' },
            budget: { type: 'STRING', description: 'Optional budget hint (e.g. "budget-friendly", "premium").' },
        },
        required: ['dish'],
    },
};

async function impl(args, toolContext = {}) {
    const dish = requireNonEmptyString(args.dish, 'dish');
    const occasion = optionalString(args.occasion, 100);
    const budget = optionalString(args.budget, 60);

    const { hits } = search(dish, { limit: 3 });

    if (toolContext.sessionMemory) {
        toolContext.sessionMemory.recordPairingRequest({ dish, occasion, budget });
    }

    if (hits.length === 0) {
        return { found: false, dish, results: [] };
    }

    return {
        found: true,
        dish,
        occasion: occasion || null,
        results: hits.map(({ chunk }) => ({
            text: chunk.text,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
        })),
    };
}

module.exports = { declaration, impl };

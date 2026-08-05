'use strict';

const { requireNonEmptyString, optionalString } = require('./toolHelpers');
const { recommendForDish } = require('../pairing/pairingEngine');

const declaration = {
    name: 'recommend_wine_pairing',
    description: 'For an age-verified adult session, recommend Moldovan wine styles for a dish. It returns ranked options, concise reasons, and one clarification only when the dish details materially change the match.',
    parameters: {
        type: 'OBJECT',
        properties: {
            dish: { type: 'STRING', description: 'The dish or type of food to pair, in the user\'s own words.' },
            details: { type: 'STRING', description: 'Optional preparation, sauce, spice, or ingredient details.' },
            occasion: { type: 'STRING', description: 'Optional occasion (e.g. celebration, casual dinner).' },
            budget: { type: 'STRING', description: 'Optional budget hint (e.g. "budget-friendly", "premium").' },
        },
        required: ['dish'],
    },
};

async function impl(args, toolContext = {}) {
    const dish = requireNonEmptyString(args.dish, 'dish');
    if (toolContext.isAdultVerified !== true) return { found: false, error: 'age_verification_required' };
    const details = optionalString(args.details, 300);
    const occasion = optionalString(args.occasion, 100);
    const budget = optionalString(args.budget, 60);

    if (toolContext.sessionMemory) {
        toolContext.sessionMemory.recordPairingRequest({ dish: details ? `${dish}; ${details}` : dish, occasion, budget });
    }
    const result = recommendForDish({ dish, details, limit: 3 });
    return {
        found: true,
        dish,
        details: details || null,
        occasion: occasion || null,
        budget: budget || null,
        ...result,
    };
}

module.exports = { declaration, impl };

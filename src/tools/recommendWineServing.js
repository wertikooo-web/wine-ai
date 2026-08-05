'use strict';

const { requireNonEmptyString, optionalString } = require('./toolHelpers');
const { recommendForWine } = require('../pairing/pairingEngine');
const { publishedProfiles } = require('../kos/wines/wineCatalogService');

const declaration = {
    name: 'recommend_wine_serving',
    description: 'For an age-verified adult session, recommend food matches and serving guidance for a selected Moldovan wine style. Use only after the wine name, grape, or label details are known.',
    parameters: {
        type: 'OBJECT',
        properties: {
            wine: { type: 'STRING', description: 'Wine name exactly as stated by the user or label.' },
            grapes: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional grape varieties from the label or confirmed knowledge.' },
            color: { type: 'STRING', description: 'Optional wine colour.' },
            sweetness: { type: 'STRING', description: 'Optional sweetness level.' },
            description: { type: 'STRING', description: 'Optional confirmed tasting or product description.' },
        },
        required: ['wine'],
    },
};

async function impl(args, toolContext = {}) {
    const wine = requireNonEmptyString(args.wine, 'wine');
    if (toolContext.isAdultVerified !== true) return { found: false, error: 'age_verification_required' };
    const catalogProfiles = await publishedProfiles().catch(() => []);
    const result = recommendForWine({
        wine,
        grapes: Array.isArray(args.grapes) ? args.grapes.map((value) => optionalString(value, 80)).filter(Boolean) : [],
        color: optionalString(args.color, 40),
        sweetness: optionalString(args.sweetness, 40),
        description: optionalString(args.description, 500),
        catalogProfiles,
    });
    if (result.found && toolContext.sessionMemory) toolContext.sessionMemory.recordDiscussedWine(wine);
    return { wine, ...result };
}

module.exports = { declaration, impl };

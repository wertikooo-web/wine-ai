'use strict';

const { search } = require('../knowledge/search');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'compare_grape_varieties',
    description: 'Compare two grape varieties (e.g. an autochthonous Moldovan variety against an international one). Call this before making any comparative statement about two grape varieties.',
    parameters: {
        type: 'OBJECT',
        properties: {
            grapeA: { type: 'STRING', description: 'The first grape variety.' },
            grapeB: { type: 'STRING', description: 'The second grape variety.' },
            language: { type: 'STRING', description: 'Optional ISO language code (ru, ro, en) to prefer for results.' },
        },
        required: ['grapeA', 'grapeB'],
    },
};

async function findGrapeProfile(grapeName, language) {
    const { hits } = search(grapeName, { language: language || null, limit: 2 });
    return hits.map(({ chunk }) => ({
        text: chunk.text,
        source: chunk.metadata.source,
        confidence: chunk.metadata.confidence,
    }));
}

async function impl(args) {
    const grapeA = requireNonEmptyString(args.grapeA, 'grapeA');
    const grapeB = requireNonEmptyString(args.grapeB, 'grapeB');
    const language = optionalString(args.language, 8) || null;

    const [profileA, profileB] = await Promise.all([
        findGrapeProfile(grapeA, language),
        findGrapeProfile(grapeB, language),
    ]);

    return {
        grape_a: { name: grapeA, found: profileA.length > 0, results: profileA },
        grape_b: { name: grapeB, found: profileB.length > 0, results: profileB },
    };
}

module.exports = { declaration, impl };

'use strict';

const { search } = require('../knowledge/search');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_wine_knowledge',
    description: 'Search the Moldovan wine knowledge base for factual information. Call this before answering any factual question about wines, wineries, grape varieties, regions, or wine tourism — never answer from memory alone. Returns relevant fragments with their source.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: { type: 'STRING', description: 'The factual question or topic to search for, in the user\'s own words.' },
            language: { type: 'STRING', description: 'Optional ISO language code (ru, ro, en) to prefer for results.' },
        },
        required: ['query'],
    },
};

async function impl(args) {
    const query = requireNonEmptyString(args.query, 'query');
    const language = optionalString(args.language, 8) || null;
    const { hits } = search(query, { language, limit: 4 });

    if (hits.length === 0) {
        return { found: false, results: [] };
    }

    return {
        found: true,
        results: hits.map(({ chunk, score }) => ({
            text: chunk.text,
            title: chunk.metadata.title,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
            language: chunk.metadata.language,
            relevance_score: score,
        })),
    };
}

module.exports = { declaration, impl };

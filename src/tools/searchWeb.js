'use strict';

// External web search tool — makes REAL network calls to DuckDuckGo.
// This is a server-side tool exposed to the LLM for external information lookup.

const { searchWeb, searchOfficialSite, searchWineInfo } = require('../knowledge/webSearch');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_web',
    description: 'Search the internet for current information about wines, wineries, grape varieties, regions, prices, availability, or any wine-related topic. Use this when: (1) the internal knowledge base did not have the answer, (2) the user asks for current prices, availability, or opening hours, (3) the user asks about an entity not in the internal database, (4) the user explicitly asks to check online. Returns real web pages with URLs and snippets that you must cite in your answer.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'The search query. Include the entity name and what you are looking for. Keep proper nouns exactly as written.',
            },
            language: {
                type: 'STRING',
                description: 'Optional language preference: "ru", "ro", or "en".',
            },
        },
        required: ['query'],
    },
};

async function impl(args) {
    const query = requireNonEmptyString(args.query, 'query');
    const language = optionalString(args.language, 8) || null;

    const result = await searchWeb(query, { language, maxResults: 5 });

    if (!result.found) {
        return {
            found: false,
            results: [],
            instruction: 'No web results found. Do not invent an answer — tell the user the information was not found online.',
            tookMs: result.tookMs,
        };
    }

    return {
        found: true,
        results: result.results.map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            source_type: r.source_type,
            confidence: r.confidence,
        })),
        instruction: 'Use these web results to answer the user question. Always cite the source URL. Only state facts that appear in these results — do not invent details.',
        tookMs: result.tookMs,
    };
}

module.exports = { declaration, impl };

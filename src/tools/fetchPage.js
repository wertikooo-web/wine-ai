'use strict';

// Page fetcher tool — loads a specific web page and extracts its text content.
// Used when the LLM needs to read a specific official page for structured facts.

const { fetchPage, fetchAndExtract, extractFacts } = require('../knowledge/pageCrawler');
const { requireNonEmptyString } = require('./toolHelpers');

const declaration = {
    name: 'fetch_page',
    description: 'Load a specific web page and extract its text content and structured facts (phone, email, address, opening hours, etc.). Use this when you have a specific URL from a web search result and need to read its content. Only works for pre-approved domains (official winery sites, wine.md, government/tourism portals).',
    parameters: {
        type: 'OBJECT',
        properties: {
            url: {
                type: 'STRING',
                description: 'The URL of the page to fetch. Must be from an allowed domain.',
            },
        },
        required: ['url'],
    },
};

async function impl(args) {
    const url = requireNonEmptyString(args.url, 'url');

    const result = await fetchAndExtract(url);

    if (!result.found) {
        return {
            found: false,
            error: result.error || 'page_not_found',
            instruction: `Could not load the page (${result.error || 'unknown error'}). Do not invent content — tell the user the page could not be loaded.`,
            tookMs: result.tookMs,
        };
    }

    return {
        found: true,
        title: result.title,
        url: result.url,
        text: result.text.slice(0, 8000),
        facts: result.facts || {},
        contentType: result.contentType,
        fetchedAt: result.fetchedAt,
        instruction: 'Use this page content to answer. Cite the URL as source. Only state facts that appear in this content.',
        tookMs: result.tookMs,
    };
}

module.exports = { declaration, impl };

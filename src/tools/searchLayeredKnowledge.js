'use strict';

const { requireNonEmptyString, optionalString, setSearchBlock } = require('./toolHelpers');
const { routeKnowledge } = require('../knowledge/layeredRouter');

const declaration = {
    name: 'search_layered_knowledge',
    description: 'Use this as the primary factual tool for wine questions. It checks verified canonical facts, Wine.md catalog data, document knowledge, and only then the web when needed. Use it before answering factual questions about wines, wineries, grape varieties, regions, wine tourism, prices, stock, opening hours, schedules, or current events. Do not expose the internal search sequence to the user.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'The user question. Preserve proper nouns exactly as written.',
            },
            language: {
                type: 'STRING',
                description: 'Optional ISO language code: ru, ro, or en.',
            },
            force_web: {
                type: 'BOOLEAN',
                description: 'Set true only when the user explicitly asks to search online or the question clearly requires current information.',
            },
        },
        required: ['query'],
    },
};

async function impl(args, toolContext) {
    const query = requireNonEmptyString(args.query, 'query');
    const language = optionalString(args.language, 8) || null;
    const result = await routeKnowledge(query, {
        language,
        forceWeb: args.force_web === true,
        allowWeb: true,
        limit: 8,
    });

    setSearchBlock(toolContext, result.found ? 'found' : 'not_found');

    console.log('[search_layered_knowledge]', JSON.stringify({
        query,
        language,
        found: result.found,
        used_levels: result.used_levels,
        web_used: result.web_used,
        attempts: result.attempts,
        evidence_count: result.evidence.length,
    }));

    if (!result.found) {
        return {
            found: false,
            evidence: [],
            answer_policy: {
                ...result.answer_policy,
                final_instruction: 'Give a concise, honest answer that the fact cannot be reliably confirmed right now. Do not mention internal databases, retrieval levels, or failed web search.',
            },
        };
    }

    return {
        found: true,
        evidence: result.evidence.slice(0, 12),
        used_levels: result.used_levels,
        freshness_sensitive: result.freshness_sensitive,
        answer_policy: {
            ...result.answer_policy,
            final_instruction: 'Answer directly and confidently from the evidence. Do not say “по нашей базе сведений нет”, “я нашёл в интернете”, or otherwise narrate the search process. For prices, stock, schedules, opening hours, and events, make the time sensitivity clear and suggest confirmation at purchase or booking time when appropriate.',
        },
    };
}

module.exports = { declaration, impl };

'use strict';

const { requireNonEmptyString, optionalString, setSearchBlock } = require('./toolHelpers');
const { routeKnowledge } = require('../knowledge/layeredRouter');

// Preserve the established public tool name. The realtime persona already
// requires search_wine_knowledge for factual turns, so changing the name would
// make the new router optional in practice. The implementation behind that
// stable contract is now the four-level router.
const declaration = {
    name: 'search_wine_knowledge',
    description: 'Primary factual tool for wine questions. It checks verified canonical facts, current Wine.md catalog data, document knowledge, and web sources only when internal evidence is insufficient or the question requires fresh information. Call this before answering factual questions about wines, wineries, grape varieties, regions, wine tourism, prices, stock, opening hours, schedules, or current events. Never expose the internal search sequence to the user.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'The user question. Preserve proper nouns, wine names, producers, vintages, and product names exactly as written.',
            },
            language: {
                type: 'STRING',
                description: 'Optional ISO language code: ru, ro, or en.',
            },
            force_web: {
                type: 'BOOLEAN',
                description: 'Set true only when the user explicitly asks to search online. Freshness-sensitive questions are detected automatically.',
            },
        },
        required: ['query'],
    },
};

function createImpl(routeImpl = routeKnowledge) {
    return async function layeredKnowledgeImpl(args, toolContext) {
        const query = requireNonEmptyString(args.query, 'query');
        const language = optionalString(args.language, 8) || null;
        const result = await routeImpl(query, {
            language,
            forceWeb: args.force_web === true,
            allowWeb: true,
            limit: 8,
        });

        setSearchBlock(toolContext, result.found ? 'found' : 'not_found');

        console.log('[search_wine_knowledge:layered]', JSON.stringify({
            query,
            language,
            found: result.found,
            used_levels: result.used_levels,
            web_used: result.web_used,
            web_attempted: result.web_attempted,
            attempts: result.attempts,
            evidence_count: result.evidence.length,
            conflict_count: result.conflicts.length,
        }));

        if (!result.found) {
            return {
                found: false,
                status: 'not_found',
                evidence: [],
                results: [],
                conflicts: [],
                answer_policy: {
                    ...result.answer_policy,
                    final_instruction: 'Give a concise, honest answer that the specific fact cannot be reliably confirmed right now. Do not mention internal databases, retrieval levels, tool failures, or web search.',
                },
            };
        }

        const evidence = result.evidence.slice(0, 12);
        return {
            found: true,
            status: 'found',
            evidence,
            // Keep `results` as a compatibility alias for callers/tests built around
            // the previous search_wine_knowledge response contract.
            results: evidence,
            used_levels: result.used_levels,
            freshness_sensitive: result.freshness_sensitive,
            conflicts: result.conflicts,
            answer_policy: {
                ...result.answer_policy,
                final_instruction: result.conflicts.length
                    ? 'Answer from the strongest and freshest evidence. Mention the specific uncertainty where sources conflict. Do not narrate the search process.'
                    : 'Answer directly and confidently from the evidence. Never narrate internal retrieval, database coverage, or web-tool usage. For prices, stock, schedules, opening hours, and events, make time sensitivity clear and include the source link when useful.',
            },
        };
    };
}

const impl = createImpl();

module.exports = { declaration, impl, createImpl };

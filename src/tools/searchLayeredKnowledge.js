'use strict';

const { requireNonEmptyString, optionalString, setSearchBlock } = require('./toolHelpers');
const { routeKnowledgeWithAnswerabilityGate } = require('../knowledge/layeredRouter');

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

function createImpl(routeImpl = routeKnowledgeWithAnswerabilityGate) {
    return async function layeredKnowledgeImpl(args, toolContext) {
        const query = requireNonEmptyString(args.query, 'query');
        const language = optionalString(args.language, 8) || null;
        // allowWeb stays true here (unchanged from before this gate existed)
        // -- the live assistant has always been permitted to reach the web;
        // routeKnowledgeWithAnswerabilityGate is what now decides WHEN that
        // permission is actually used (freshness, or evidence that doesn't
        // answer the question), same as it does for the eval tool.
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
            answerable: result.answerable,
            answerabilityReason: result.answerabilityReason,
            used_levels: result.used_levels,
            webUsed: result.web_used,
            web_attempted: result.web_attempted,
            attempts: result.attempts,
            evidence_count: result.evidence.length,
            conflict_count: result.conflicts?.length || 0,
        }));

        if (!result.found) {
            return {
                found: false,
                answerable: false,
                answerabilityReason: result.answerabilityReason || 'no_evidence',
                webUsed: result.web_used === true,
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

        if (result.answerable === false) {
            // Fragments were retrieved (found:true) but the answerability
            // gate -- and, when allowed, a web fallback already attempted
            // inside it -- could not confirm they cover this specific
            // question. Topical similarity is not knowledge: tell the
            // model to say so honestly instead of answering from
            // loosely-related fragments.
            return {
                found: true,
                answerable: false,
                answerabilityReason: result.answerabilityReason || null,
                webUsed: result.web_used === true,
                status: 'insufficient',
                evidence,
                results: evidence,
                used_levels: result.used_levels,
                freshness_sensitive: result.freshness_sensitive,
                conflicts: result.conflicts,
                answer_policy: {
                    ...result.answer_policy,
                    final_instruction: 'The evidence below is topically related but does not actually contain a direct answer to this specific question. Give a concise, honest answer that this specific fact cannot be reliably confirmed right now. Do not guess or answer from loosely-related evidence, and do not mention internal databases, retrieval levels, or web search.',
                },
            };
        }

        return {
            found: true,
            answerable: true,
            answerabilityReason: result.answerabilityReason || null,
            webUsed: result.web_used === true,
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

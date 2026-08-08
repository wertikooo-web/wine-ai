'use strict';

const { requireNonEmptyString, optionalString, setSearchBlock } = require('./toolHelpers');
const { routeKnowledgeWithAnswerabilityGate, CLAIM_CLASSES } = require('../knowledge/layeredRouter');
const { resolveAnswerMode, modePolicy } = require('../knowledge/answerModes');
const {
    buildClaimsFromEvidence,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
} = require('../knowledge/claimProvenance');

// A follow-up turn arrives at the tool as bare text ("А какое из них легче?")
// with no referent -- retrieval then searches for nothing in particular. The
// realtime session already keeps `recentTurns` (realtimeServer.js), so the fix
// is to reuse it, not to build a memory system: when the current turn reads as
// referent-dependent, prepend the most recent USER turn text to the retrieval
// query so the entities being discussed are actually in the search string.
const REFERENT_DEPENDENT_RE = /(^|\s)(их|них|него|не[её]|это|этих|этот|эта|эти|том|тот|та|те|такое|такой|оно|он|она|они|acest|acel|ele|ei|them|it|this|that|those)(\s|$|[,?.!])/iu;
const SHORT_FOLLOWUP_MAX_CHARS = 60;

function looksReferentDependent(query) {
    const text = String(query || '').trim();
    if (!text) return false;
    if (REFERENT_DEPENDENT_RE.test(text)) return true;
    // "А какое легче?" / "И подешевле?" -- short, starts with a connective,
    // names nothing.
    return text.length <= SHORT_FOLLOWUP_MAX_CHARS && /^(а|и|но|ещ[её]|тогда|okay|ok|and|but|iar|și)\b/iu.test(text);
}

// Returns the query actually sent to retrieval. Never replaces the user's own
// words -- it only appends prior USER turns as extra context, so proper nouns
// in the current turn are still preserved exactly.
function enrichQueryWithRecentTurns(query, toolContext) {
    const turns = Array.isArray(toolContext?.recentTurns) ? toolContext.recentTurns : [];
    if (!turns.length || !looksReferentDependent(query)) return { query, enriched: false };
    const priorUserTurns = turns
        .filter((turn) => turn && turn.role === 'user' && String(turn.text || '').trim())
        .map((turn) => String(turn.text).trim())
        .filter((text) => text !== String(query).trim())
        .slice(-2);
    if (!priorUserTurns.length) return { query, enriched: false };
    return { query: `${priorUserTurns.join(' ')} ${query}`.slice(0, 600), enriched: true };
}

// Preserve the established public tool name. The realtime persona already
// requires search_wine_knowledge for factual turns, so changing the name would
// make the new router optional in practice. The implementation behind that
// stable contract is now the four-level router.
const declaration = {
    name: 'search_wine_knowledge',
    description: 'Primary factual tool for wine questions and general factual questions. It checks verified canonical facts, current Wine.md catalog data, and document knowledge first. For questions about our own wines/wineries/catalog, web is used only for freshness (price, stock, hours, events) or when internal evidence does not cover the question. For general wine knowledge (grapes, regions, history, styles, pairings, ratings, travel, culture) and other factual/current questions, web search runs proactively alongside internal knowledge. Call this before answering any factual question. Never expose the internal search sequence to the user.',
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
            answer_mode: {
                type: 'STRING',
                enum: ['knowledge_only', 'knowledge_catalog', 'knowledge_web', 'expert'],
                description: 'Optional. Default knowledge_web: canonical facts + Wine.md catalog + documents + controlled web fallback. knowledge_only: canonical facts + documents only (no prices/stock/web). knowledge_catalog: canonical + documents + Wine.md catalog, no web. expert: all levels plus explicit AI inference is permitted.',
            },
        },
        required: ['query'],
    },
};

function createImpl(routeImpl = routeKnowledgeWithAnswerabilityGate) {
    return async function layeredKnowledgeImpl(args, toolContext) {
        const query = requireNonEmptyString(args.query, 'query');
        const language = optionalString(args.language, 8) || null;
        const answerMode = resolveAnswerMode(args.answer_mode);
        const { query: retrievalQuery, enriched: queryEnriched } = enrichQueryWithRecentTurns(query, toolContext);
        // The live assistant defaults to the full knowledge_web mode: canonical
        // facts, Wine.md catalog, documents, and the web fallback gated exactly
        // as routeKnowledgeWithAnswerabilityGate decides. An explicit
        // answer_mode narrows the allowed levels (knowledge_only, for example,
        // forbids catalog/web even for price questions -- the router then
        // simply never consults them, and claims reflect only what was
        // allowed).
        const policy = modePolicy(answerMode);
        const result = await routeImpl(retrievalQuery, {
            language,
            forceWeb: args.force_web === true,
            allowWeb: policy.allowWeb,
            allowCatalog: policy.allowCatalog,
            limit: 8,
        });

        setSearchBlock(toolContext, result.found ? 'found' : 'not_found');

        // Claim-level provenance (phase 1): each retrieved item is classified
        // into a claim kind with its source/confidence/checked-at timestamps,
        // conflicts are surfaced per-claim, and the answer_mode is echoed so
        // the consumer knows exactly which levels these claims may come from.
        const evidence = (result.evidence || []).slice(0, 12);
        const allowedLevels = new Set(policy.levels);
        const allowedEvidence = evidence.filter((item) => allowedLevels.has(item.level));
        const claims = annotateConflicts(buildClaimsFromEvidence(allowedEvidence), result.conflicts || [])
            .map((claim) => { const { _conflict_key, ...rest } = claim; return rest; });
        const freshness = summarizeFreshness(claims, result.freshness_sensitive === true);

        const webSources = evidence
            .filter((item) => item.level === 'web')
            .map((item) => ({ title: item.title, url: item.source }));

        // Warm, honest sommelier voice -- NOT legalese. The refusal must sound
        // like a professional who won't invent a number, and must always offer
        // the next useful thing.
        const GROUNDED_REFUSAL_INSTRUCTION = 'Be honest: this specific fact cannot be reliably confirmed right now. Say so in the sommelier\'s own warm, natural voice -- that you do not currently see confirmed information about this particular detail and will not invent it -- then offer something genuinely useful you CAN speak to (the style, the grape, the region, the producer in general, or checking another detail). Two short spoken sentences, no bureaucratic or legalistic phrasing, no apology loops. Do not state or imply any specific unverified value. Do not mention internal databases, retrieval levels, evidence, or web search.';
        const GENERAL_KNOWLEDGE_INSTRUCTION = 'This is a general wine-knowledge question, not a claim about a specific named product. Answer it fully and confidently in your own sommelier voice from your professional knowledge -- do NOT refuse and do NOT say the information is unconfirmed. The fragments below (if any) are only loosely related; ignore them rather than forcing them in. The single hard limit: do not attribute any specific figure, vintage, award, price, or producer-stated spec to a specific named wine or winery unless it appears in the evidence.';
        const ENTITY_MISMATCH_NOTE = ' Important: some retrieved material concerns a DIFFERENT producer or wine than the one asked about. Never transfer a fact from one producer or bottling to another; only state a fact if it is explicitly about the entity the user asked about.';

        const claimClass = result.claim_class || null;
        const isGeneralKnowledge = claimClass === CLAIM_CLASSES.GENERAL_KNOWLEDGE;
        const entityMatch = result.evidence_entity_match || null;

        console.log('[search_wine_knowledge:layered]', JSON.stringify({
            query,
            retrievalQuery: queryEnriched ? retrievalQuery : undefined,
            queryEnriched,
            answerMode,
            claimClass,
            entityMatch,
            language,
            queryIntent: result.query_intent,
            found: result.found,
            answerable: result.answerable,
            answerabilityReason: result.answerabilityReason,
            used_levels: result.used_levels,
            webUsed: result.web_used,
            webReason: result.web_reason,
            web_attempted: result.web_attempted,
            webSources,
            attempts: result.attempts,
            evidence_count: result.evidence.length,
            conflict_count: result.conflicts?.length || 0,
        }));

        if (!result.found) {
            return {
                found: false,
                // Retrieval finding nothing is not the same as the assistant
                // being forbidden to answer. For a general wine-knowledge
                // question the model's own training is a legitimate source and
                // carries no risk of inventing a specific unverifiable fact.
                answerable: isGeneralKnowledge ? true : false,
                claimClass,
                answerabilityReason: result.answerabilityReason || 'no_evidence',
                webUsed: result.web_used === true,
                status: isGeneralKnowledge ? 'general_knowledge' : 'not_found',
                answer_mode: answerMode,
                evidence: [],
                results: [],
                conflicts: [],
                claims: [],
                freshness: { freshness_sensitive: result.freshness_sensitive === true, dynamic_fields_present: false, synced_through: null },
                answer_policy: {
                    ...result.answer_policy,
                    final_instruction: isGeneralKnowledge
                        ? GENERAL_KNOWLEDGE_INSTRUCTION
                        : GROUNDED_REFUSAL_INSTRUCTION,
                },
            };
        }

        // Treat "no" (false) and "unknown" (null -- grader unavailable or
        // unparseable) identically here -- neither may let the assistant
        // present loosely-related evidence as a verified fact. `undefined`
        // (a routeImpl that doesn't run the gate at all, e.g. a bare
        // routeKnowledge() passed directly) is deliberately NOT included:
        // that's a caller opting out of answerability grading entirely, not
        // a "checked and failed" or "checked and unknown" outcome, so it
        // must keep the pre-gate behavior of trusting `found`.
        if (result.answerable === false || result.answerable === null) {
            // Fragments were retrieved (found:true) but the answerability
            // gate -- and, when allowed, a web fallback already attempted
            // inside it -- could not confirm they cover this specific
            // question. Topical similarity is not knowledge: tell the
            // model to say so honestly instead of answering from
            // loosely-related fragments.
            return {
                found: true,
                // Preserve the real tri-state signal (false = checked and
                // rejected, null = unknown/grader unavailable) rather than
                // collapsing both to false -- logs and the dashboard need to
                // be able to tell "confirmed insufficient" apart from
                // "we genuinely don't know".
                answerable: isGeneralKnowledge
                    ? true
                    : (result.answerable === true ? true : result.answerable),
                claimClass,
                entityMatch,
                answerabilityReason: result.answerabilityReason || null,
                webUsed: result.web_used === true,
                webReason: result.web_reason || null,
                webSources,
                status: isGeneralKnowledge ? 'general_knowledge' : 'insufficient',
                evidence,
                results: evidence,
                answer_mode: answerMode,
                claims,
                freshness,
                used_levels: result.used_levels,
                freshness_sensitive: result.freshness_sensitive,
                conflicts: result.conflicts,
                answer_policy: {
                    ...result.answer_policy,
                    final_instruction: isGeneralKnowledge
                        ? GENERAL_KNOWLEDGE_INSTRUCTION
                        : `The evidence below is topically related but does not actually contain a direct answer to this specific question. ${GROUNDED_REFUSAL_INSTRUCTION}${entityMatch === 'mismatch' ? ENTITY_MISMATCH_NOTE : ''}`,
                },
            };
        }

        return {
            found: true,
            answerable: true,
            claimClass,
            entityMatch,
            answerabilityReason: result.answerabilityReason || null,
            webUsed: result.web_used === true,
            webReason: result.web_reason || null,
            webSources,
            status: 'found',
            evidence,
            // Keep `results` as a compatibility alias for callers/tests built around
            // the previous search_wine_knowledge response contract.
            results: evidence,
            answer_mode: answerMode,
            claims,
            freshness,
            used_levels: result.used_levels,
            freshness_sensitive: result.freshness_sensitive,
            conflicts: result.conflicts,
            answer_policy: {
                ...result.answer_policy,
                final_instruction: (result.conflicts.length
                    ? 'Answer from the strongest and freshest evidence. Mention the specific uncertainty where sources conflict. Do not narrate the search process.'
                    : 'Answer directly and confidently from the evidence. Never narrate internal retrieval, database coverage, or web-tool usage. For prices, stock, schedules, opening hours, and events, make time sensitivity clear and include the source link when useful.')
                    + (entityMatch === 'mismatch' || entityMatch === 'unverified_after_web' ? ENTITY_MISMATCH_NOTE : ''),
            },
        };
    };
}

const impl = createImpl();

module.exports = { declaration, impl, createImpl };

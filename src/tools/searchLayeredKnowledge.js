'use strict';

const { requireNonEmptyString, optionalString, setSearchBlock } = require('./toolHelpers');
const { routeKnowledgeWithAnswerabilityGate, CLAIM_CLASSES } = require('../knowledge/layeredRouter');
const { resolveAnswerMode, modePolicy } = require('../knowledge/answerModes');
const { SELECTIVE_RAG_MODE } = require('../config/env');
const { routeSelective } = require('../knowledge/selectiveRagRouter');
const {
    buildClaimsFromEvidence,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
} = require('../knowledge/claimProvenance');
const { attemptRecovery } = require('../knowledge/usefulRecovery');
const { inferForQuestion } = require('../knowledge/wineIntelligence');

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
                description: 'Optional. Default knowledge_web: canonical facts + Wine.md catalog + documents + controlled web fallback. knowledge_only: canonical facts + documents only (no prices/stock/web). knowledge_catalog: canonical + documents + Wine.md catalog, no web. expert: all levels. Wine Intelligence (recommendation/pairing/comparison/route) runs automatically when the question is a Phase 6 ask; answer_mode controls the knowledge levels, not the inference gate.',
            },
        },
        required: ['query'],
    },
};

// Selective RAG shadow observer -- STEP 5/6/7 of the shadow-mode rollout.
// Runs the deterministic router (routeSelective) purely for observation: it
// logs a DIRECT/GROUNDED decision alongside the retrieval the OLD production
// pipeline actually performed. It never gates, skips, or short-circuits
// retrieval, never calls Gemini/any LLM, and a thrown/failing router can
// never affect the user-facing request -- the caller's production path runs
// unconditionally either way. Near-zero overhead when SELECTIVE_RAG_MODE is
// 'off' (the default): a single string compare, no router call at all.
function runShadowRouterObserver(query, toolContext) {
    if (SELECTIVE_RAG_MODE !== 'shadow') return null;
    const startedAt = process.hrtime.bigint();
    try {
        const recentTurns = Array.isArray(toolContext?.recentTurns) ? toolContext.recentTurns : [];
        const result = routeSelective(query, { recentTurns });
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return {
            route: result.path,
            reason: result.reason,
            entity: result.entity || null,
            conversationContextUsed: recentTurns.length > 0,
            latencyMs,
            error: null,
        };
    } catch (err) {
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        return {
            route: null,
            reason: null,
            entity: null,
            conversationContextUsed: false,
            latencyMs,
            error: String(err && err.message || err),
        };
    }
}

// Adds the Phase 6 Wine Intelligence inference block when a Phase 6 intent is
// detected. Transparent addition on top of the existing retrieval contract:
// `claimClass`, `answerable`, `claims`, and `recovery` never change. It also
// appends a voice-safe instruction so the model presents the recommendation
// in the sommelier's own voice and never narrates inference internals.
const INFERENCE_GUIDANCE = ' The result includes an "inference" block. Present its recommendation naturally in your own sommelier voice as advice, not as a verified fact. The "explanation" lines are the reasons behind the suggestion and "claims" are the confirmed facts you may quote. Never state a wine, winery, vintage, price, award, or location as fact unless it appears in "claims" with a source. If "found" is false, say honestly that you cannot yet confidently recommend from confirmed data, ask one short clarifying question, or offer a nearby alternative. Never mention "inference", scenario names, claim kinds, RAG, retrieval, databases, answerability, or any internal mechanism.';
function attachInference(output, inference) {
    if (!inference) return output;
    return {
        ...output,
        inference,
        answer_policy: output.answer_policy
            ? { ...output.answer_policy, final_instruction: (output.answer_policy.final_instruction || '') + INFERENCE_GUIDANCE }
            : output.answer_policy,
    };
}

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
        const requestStartedAt = process.hrtime.bigint();
        // Shadow observer runs BEFORE the production call and never affects
        // it: same retrievalQuery is used below either way, unconditionally.
        const shadow = runShadowRouterObserver(retrievalQuery, toolContext);
        const retrievalStartedAt = process.hrtime.bigint();
        const result = await routeImpl(retrievalQuery, {
            language,
            forceWeb: args.force_web === true,
            allowWeb: policy.allowWeb,
            allowCatalog: policy.allowCatalog,
            limit: 8,
        });
        if (shadow) {
            const retrievalLatencyMs = Number(process.hrtime.bigint() - retrievalStartedAt) / 1e6;
            const totalLatencyMs = Number(process.hrtime.bigint() - requestStartedAt) / 1e6;
            console.log('[selective_rag_shadow]', JSON.stringify({
                route: shadow.route,
                reason: shadow.reason,
                entity: shadow.entity,
                conversationContextUsed: shadow.conversationContextUsed,
                routerLatencyMs: Number(shadow.latencyMs.toFixed(3)),
                actualLevelsUsed: result.used_levels || [],
                actualWebUsed: result.web_used === true,
                retrievalLatencyMs: Number(retrievalLatencyMs.toFixed(3)),
                totalLatencyMs: Number(totalLatencyMs.toFixed(3)),
                error: shadow.error,
            }));
        }

        // Phase 6 Wine Intelligence: gated by INTENT, not by the answer mode.
        // Whenever a Phase 6 scenario is detected (pairing, preference
        // recommendation, comparison, route planning) -- the ordinary user
        // path included -- run the deterministic inference layer over the same
        // knowledge levels and attach the explainable result as a separate
        // `inference` block. Factual turns ("сколько стоит вино Cricova",
        // "расскажи о виноделии") never trigger it. A failing or empty
        // inference is never fatal and never changes the retrieval outcome.
        let inference = null;
        try {
            inference = await inferForQuestion(query, {
                language,
                allowWeb: policy.allowWeb,
                allowCatalog: policy.allowCatalog,
                limit: 8,
            });
        } catch (error) {
            console.log('[wine_intelligence]', error && error.message || error);
        }

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
            if (isGeneralKnowledge) {
                return attachInference({
                    found: false,
                    // Retrieval finding nothing is not the same as the assistant
                    // being forbidden to answer. For a general wine-knowledge
                    // question the model's own training is a legitimate source and
                    // carries no risk of inventing a specific unverifiable fact.
                    answerable: true,
                    claimClass,
                    answerabilityReason: result.answerabilityReason || 'no_evidence',
                    webUsed: result.web_used === true,
                    status: 'general_knowledge',
                    answer_mode: answerMode,
                    evidence: [],
                    results: [],
                    conflicts: [],
                    claims: [],
                    freshness: { freshness_sensitive: result.freshness_sensitive === true, dynamic_fields_present: false, synced_through: null },
                    answer_policy: {
                        ...result.answer_policy,
                        final_instruction: GENERAL_KNOWLEDGE_INSTRUCTION,
                    },
                }, inference);
            }

            // Useful Answer Recovery: retrieval found nothing for an
            // entity-specific question. Before collapsing into the dead-end
            // refusal, run one deterministic recovery pass through the SAME
            // router (injected adapters stay honored): reframe the question
            // and discover the closest supported facts or alternatives. If
            // nothing supported exists, the response is byte-for-byte the old
            // honest refusal -- no regression.
            const recovery = await attemptRecovery({
                question: retrievalQuery,
                language,
                retrieval: result,
                discoveryRouter: routeImpl,
                evidence: [],
                conflicts: result.conflicts,
                allowedLevels: policy.levels,
                allowCatalog: policy.allowCatalog,
                skipAnswerability: true,
            });
            if (recovery && recovery.applied) {
                const recoveryFreshness = summarizeFreshness(recovery.claims, result.freshness_sensitive === true);
                return attachInference({
                    found: false,
                    // Recovery never flips the gate: `answerable` stays false.
                    // It only supplies confirmed adjacent facts the model may
                    // speak to instead of a blanket refusal.
                    answerable: false,
                    claimClass,
                    answerabilityReason: result.answerabilityReason || 'no_evidence',
                    webUsed: result.web_used === true,
                    status: 'recovered',
                    answer_mode: answerMode,
                    evidence: recovery.candidates,
                    results: recovery.candidates,
                    conflicts: recovery.conflicts,
                    claims: recovery.claims,
                    used_levels: [...new Set(recovery.candidates.map((item) => item.level))],
                    freshness: recoveryFreshness,
                    freshness_sensitive: result.freshness_sensitive === true,
                    recovery: {
                        applied: true,
                        strategy: recovery.strategy,
                        reason: recovery.reason,
                        final_instruction: recovery.final_instruction,
                    },
                    answer_policy: {
                        ...result.answer_policy,
                        final_instruction: recovery.final_instruction,
                    },
                }, inference);
            }

            return attachInference({
                found: false,
                answerable: false,
                claimClass,
                answerabilityReason: result.answerabilityReason || 'no_evidence',
                webUsed: result.web_used === true,
                status: 'not_found',
                answer_mode: answerMode,
                evidence: [],
                results: [],
                conflicts: [],
                claims: [],
                freshness: { freshness_sensitive: result.freshness_sensitive === true, dynamic_fields_present: false, synced_through: null },
                answer_policy: {
                    ...result.answer_policy,
                    final_instruction: GROUNDED_REFUSAL_INSTRUCTION,
                },
            }, inference);
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
            // question. Topical similarity is not knowledge. Useful Answer
            // Recovery gets one deterministic pass: either the fragments
            // partially cover the question (answer only the confirmed part)
            // or -- on a declared entity mismatch -- discovery finds confirmed
            // alternatives instead of reusing another producer's evidence.
            if (!isGeneralKnowledge) {
                const recovery = await attemptRecovery({
                    question: retrievalQuery,
                    language,
                    retrieval: result,
                    discoveryRouter: routeImpl,
                    evidence: allowedEvidence,
                    conflicts: result.conflicts,
                    allowedLevels: policy.levels,
                    allowCatalog: policy.allowCatalog,
                    skipAnswerability: true,
                });
                if (recovery && recovery.applied) {
                    const recoveryFreshness = summarizeFreshness(recovery.claims, result.freshness_sensitive === true);
                    return attachInference({
                        found: true,
                        // Preserve the real tri-state signal (false = checked
                        // and rejected, null = unknown/grader unavailable) --
                        // recovery enriches, it never flips answerable.
                        answerable: result.answerable === true ? true : result.answerable,
                        claimClass,
                        entityMatch,
                        answerabilityReason: result.answerabilityReason || null,
                        webUsed: result.web_used === true,
                        webReason: result.web_reason || null,
                        webSources,
                        status: 'recovered',
                        evidence: recovery.candidates,
                        results: recovery.candidates,
                        answer_mode: answerMode,
                        claims: recovery.claims,
                        freshness: recoveryFreshness,
                        used_levels: [...new Set(recovery.candidates.map((item) => item.level))],
                        freshness_sensitive: result.freshness_sensitive,
                        conflicts: recovery.conflicts,
                        recovery: {
                            applied: true,
                            strategy: recovery.strategy,
                            reason: recovery.reason,
                            final_instruction: recovery.final_instruction,
                        },
                        answer_policy: {
                            ...result.answer_policy,
                            final_instruction: recovery.final_instruction
                                + (entityMatch === 'mismatch' ? ENTITY_MISMATCH_NOTE : ''),
                        },
                    }, inference);
                }
            }

            return attachInference({
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
            }, inference);
        }

        return attachInference({
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
        }, inference);
    };
}

const impl = createImpl();

module.exports = { declaration, impl, createImpl };

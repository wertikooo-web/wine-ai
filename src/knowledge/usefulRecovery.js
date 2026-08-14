'use strict';

// Useful Answer Recovery (answer/recovery layer).
//
// When the literal answer to a question is not sufficiently supported -- the
// answerability gate returned false/null, or retrieval found nothing and the
// claim needs grounding -- this layer recovers the CLOSEST USEFUL answer the
// corpus CAN support, instead of collapsing into the same dead-end refusal for
// every miss. One module, four strategies, all cheap and deterministic:
//
//   A. NEAREST_CONFIRMED_FACT   exact fact unavailable -> closest confirmed
//                               facts about the same subject,
//   B. PREFERENCE_DISCOVERY     subjective/fuzzy constraint (необычное,
//                               малоизвестное, семейная, young, small...) is
//                               treated as a PREFERENCE for discovery and
//                               ranking, never as a verifiable claim,
//   C. ENTITY_ALTERNATIVES      exact entity unavailable ("вместо Purcari",
//                               unknown winery) -> 1-3 confirmed alternatives,
//   D. PARTIAL_EVIDENCE         evidence partially covers -> answer only the
//                               confirmed part, softly omit the rest,
//   E. HONEST_LIMITATION        only when nothing useful exists at all: an
//                               honest, humanized limitation that continues
//                               the conversation.
//
// Anti-hallucination contract stays intact: every recovered candidate is a
// real, provenance-carrying claim from the existing pipeline (canonical /
// catalog / documents), never an invented value. Recovery never turns
// `answerable=false` into `answerable=true`; it only enriches what may be
// said when the literal answer is unsupported. No internal retrieval,
// database, or web-tool wording is ever injected into a user-facing string.

const { routeKnowledge } = require('./layeredRouter');
const {
    buildClaimsFromEvidence,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
} = require('./claimProvenance');

const CLAIM_CLASSES = Object.freeze({
    GENERAL_KNOWLEDGE: 'general_knowledge',
    GROUNDING_REQUIRED: 'grounding_required',
});

const RECOVERY_STRATEGIES = Object.freeze({
    NEAREST_CONFIRMED_FACT: 'nearest_confirmed_fact',
    PREFERENCE_DISCOVERY: 'preference_discovery',
    ENTITY_ALTERNATIVES: 'entity_alternatives',
    PARTIAL_EVIDENCE: 'partial_evidence',
    HONEST_LIMITATION: 'honest_limitation',
});

// Subjective/fuzzy modifiers (RU/RO/EN). A question containing one is treated
// as a discovery preference, not a fact to verify.
const SUBJECTIVE_RE = /(необычн|нестандартн|редк|малоизвестн|неизвестн|интересн|лучш|молод[а-я]*|аутентичн|семейн|домашн|бут[иъ]к|скромн|уник|эксклюзивн|скрыт|нов(?:ое|ая|ый|ые)|хипстер|neobișnuit|neobisnuit|rar|puțin cunoscut|putin cunoscut|interesant|tânăr|tanar|autentic|de familie|artizanal|unic|ascuns|mic|unusual|rare|little-known|lesser-known|unknown|interesting|best|young|authentic|family|homemade|boutique|niche|unique|hidden|uncommon|subtle|new|cool)/iu;

// "instead of / alternative" markers -> ENTITY_ALTERNATIVES strategy.
const ALTERNATIVE_RE = /(вместо|аналог|альтернатив|похож|замен|вместо него|другое|иной|în loc de|in loc de|alternativ|asemăn|aseman|analog|similar|alt (?:vin|ceva)|instead of|alternative to|rather than|replacement|substitute|different from)/iu;

const COLOR_WORDS = /(бел(?:ое|ого|ых|ая)|красн(?:ое|ого|ых|ая)|розов|игристов|золотист|white|red|ros[eé]|sparkling|alb(?:ă|a)?|roș(?:u|ie)|rosu|roz|spumant)/iu;

const GENERIC_DISCOVERY = Object.freeze({
    ru: 'молдавское вино',
    ro: 'vin moldovenesc',
    en: 'Moldovan wine',
});

function normalize(text) {
    return String(text || '').trim().replace(/\s+/g, ' ');
}

function languageOf(value) {
    return ['ru', 'ro', 'en'].includes(value) ? value : 'ru';
}

// Strips a quoted/bare proper-noun "вместо X {entity}" tail so alternatives
// can be discovered from the remaining category words instead of an entity
// the corpus does not support.
function stripAlternativeTarget(query) {
    const match = String(query || '').match(/(?:вместо|instead of|in loc de|în loc de|rather than|вместо него)\s+([^,;!?]+)/iu);
    if (!match) return normalize(query);
    return normalize(String(query).replace(match[0], '').replace(/,+$/u, ''));
}

function stripSubjective(query) {
    return normalize(String(query || '')
        .replace(SUBJECTIVE_RE, ' ')
        .replace(/[^\p{L}\p{N}\s-]/gu, ' '));
}

function discoveryTokens(query) {
    return stripSubjective(query)
        .split(/\s+/u)
        .map((token) => token.replace(/^[!?,.;:"«»()]+|[!?,.;:"«»()]+$/gu, ''))
        .filter((token) => token.length >= 2
            && !/(^|\b)(посовету|подбери|рекоменду|хочу|хотел|какое|какой|какая|какие|что|чем|для|чтобы|без|по|с|под|и|а|в|на|li|-?\d+|recommend|suggest|want|which|what|for|with|and|а|или|sau|vreau|recomand|recomandă)/iu.test(token));
}

// Deterministic reframed query for candidate discovery. Keeps color/type words
// and drops subjective modifiers and the strip-target of an "instead of"
// phrase; falls back to a generic, language-appropriate category query.
function buildDiscoveryQuery(question, language = 'ru') {
    const lang = languageOf(language);
    const stripped = stripAlternativeTarget(question);
    const tokens = discoveryTokens(stripped || question);
    const kept = tokens.filter((token) => COLOR_WORDS.test(token)
        || /(^|\b)(вин|винодельн|crame|cramă|winery|wine|soi|sorte|region|regiune|молдав|moldov)+/iu.test(token));
    const color = (kept.filter((token) => COLOR_WORDS.test(token))[0]) || null;
    if (kept.length >= 1 && (color || kept.length >= 2)) {
        return normalize(kept.join(' '));
    }
    return GENERIC_DISCOVERY[lang];
}

// True when the gate outcome left the assistant without a literal answer and
// recovery is a legal next step. General-knowledge questions are excluded:
// there the model's own training is the legitimate source and nothing needs
// recovering. `answerable === undefined` (a routeImpl that never ran the
// answerability gate) is also excluded: that caller opted out of grading and
// trusted `found`, so recovery must not hijack the answer.
function couldRecover(result) {
    if (!result) return false;
    if (result.claim_class === CLAIM_CLASSES.GENERAL_KNOWLEDGE) return false;
    if (result.answerable === false || result.answerable === null) return true;
    return false;
}

// Strategy selection is deterministic:
//   - a declared entity mismatch never reuses another producer's evidence,
//     even when evidence exists -> ENTITY_ALTERNATIVES,
//   - a discovery-framed request (alternative/subjective wording) is served by
//     discovery, not by recovering the literal retrieved fragments: for
//     "что-нибудь вместо X" or "посоветуй молодую малоизвестную винодельню",
//     PARTIAL_EVIDENCE would answer the unsupported literal question instead
//     of the advice the user actually asked for,
//   - otherwise, evidence was retrieved AND the gate confirmed the evidence
//     concerns the asked entity (match) but could not confirm the specific
//     value -> PARTIAL_EVIDENCE (answer the confirmed part, softly omit the
//     rest). A partial pass REQUIRES a "match" verdict: recycling fragments
//     the grader could not attribute to the asked entity (unknown winery,
//     region-level or unrelated material) would be exactly the wrong-entity
//     attribution the gate forbids -> ENTITY_ALTERNATIVES,
//   - no evidence at all -> ENTITY_ALTERNATIVES / PREFERENCE_DISCOVERY /
//     NEAREST_CONFIRMED_FACT by the question's own wording.
function classifyStrategy(result, question) {
    const q = String(question || '');
    if (result.found === true && (result.evidence || []).length > 0 && result.evidence_entity_match === 'mismatch') {
        return RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES;
    }
    if (ALTERNATIVE_RE.test(q)) return RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES;
    if (SUBJECTIVE_RE.test(q)) return RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY;
    if (result.found === true && (result.evidence || []).length > 0) {
        return result.evidence_entity_match === 'match'
            ? RECOVERY_STRATEGIES.PARTIAL_EVIDENCE
            : RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES;
    }
    return RECOVERY_STRATEGIES.NEAREST_CONFIRMED_FACT;
}

const RECOVERY_MAX_CANDIDATES = 3;
const REJECTED_CONFIDENCE = new Set(['low', 'unverified']);
const WEB_LEVEL = 'web';

// Candidate filter for recovery. Recovery stays inside the controlled corpus:
// web items are dropped (the primary path already attempted the web fallback),
// levels outside the mode's allowed set are dropped, low/unverified confidence
// is dropped, and near-duplicates collapse to the first occurrence.
function pickCandidates(evidence, { allowedLevels = null, max = RECOVERY_MAX_CANDIDATES } = {}) {
    if (!Array.isArray(evidence)) return [];
    const allowed = Array.isArray(allowedLevels) && allowedLevels.length ? new Set(allowedLevels) : null;
    const seen = new Set();
    const candidates = [];
    for (const item of evidence) {
        if (!item || !item.text) continue;
        if (item.level === WEB_LEVEL) continue;
        if (allowed && !allowed.has(item.level)) continue;
        if (REJECTED_CONFIDENCE.has(item.confidence)) continue;
        const key = `${item.level}:${item.source || ''}:${String(item.title || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(item);
        if (candidates.length >= max) break;
    }
    return candidates;
}

function claimsFromCandidates(candidates, conflicts) {
    return rankClaims(annotateConflicts(buildClaimsFromEvidence(candidates), conflicts || []))
        .map((claim) => { const { _conflict_key, ...rest } = claim; return rest; });
}

function deadEnd(reason, conflicts) {
    return {
        applied: false,
        strategy: RECOVERY_STRATEGIES.HONEST_LIMITATION,
        reason,
        candidates: [],
        claims: [],
        conflicts: conflicts || [],
        final_instruction: DEAD_END_FINAL_INSTRUCTION,
    };
}

// The recovery engine. Input is a routeKnowledgeWithAnswerabilityGate result
// (or a caller that produced the same shape); output is either null (nothing
// to recover), a `{ applied:true, strategy, candidates, claims,
// final_instruction }` block, or a `{ applied:false }` honest-limitation
// block when the corpus genuinely has nothing useful. Every candidate is a
// real, provenance-carrying claim; `answerable` is never flipped by this
// layer -- it only enriches what may be said.
async function attemptRecovery({
    question,
    language,
    retrieval,
    discoveryRouter = routeKnowledge,
    evidence,
    conflicts,
    allowedLevels = null,
    allowCatalog = true,
    skipAnswerability = true,
}) {
    const result = retrieval || {};
    if (!couldRecover(result)) return null;

    const lang = languageOf(language);
    const strategy = classifyStrategy(result, question);
    const sourceEvidence = Array.isArray(evidence) ? evidence : (result.evidence || []);

    if (strategy === RECOVERY_STRATEGIES.PARTIAL_EVIDENCE) {
        const usedConflicts = conflicts || result.conflicts || [];
        const candidates = pickCandidates(sourceEvidence, { allowedLevels });
        if (!candidates.length) return deadEnd('no_partial_evidence', usedConflicts);
        return {
            applied: true,
            strategy,
            reason: 'reuse_current_evidence',
            candidates,
            claims: claimsFromCandidates(candidates, usedConflicts),
            conflicts: usedConflicts,
            final_instruction: RECOVERY_FINAL_INSTRUCTIONS[strategy],
        };
    }

    // A/B/C need a discovery pass: reframe the question so the subjective
    // modifier or the stripped "instead of X" target is dropped, then route
    // that query through the SAME router the caller uses (so injected
    // adapters stay honored). Web is disabled on purpose -- recovery stays
    // grounded in controlled internal evidence -- and answerability grading
    // is skipped: candidate discovery only needs the routed evidence, never a
    // paid grader round-trip whose verdict would be discarded.
    let discovery;
    try {
        const discoveryQuery = buildDiscoveryQuery(question, lang);
        discovery = await discoveryRouter(discoveryQuery, {
            language: lang,
            allowWeb: false,
            allowCatalog,
            skipAnswerability,
            limit: 8,
        });
    } catch (err) {
        return deadEnd(`discovery_error:${err && err.message ? String(err.message).slice(0, 120) : 'unknown'}`);
    }

    const candidates = pickCandidates(discovery.evidence || [], { allowedLevels });
    if (!candidates.length) return deadEnd('no_candidates');
    const usedConflicts = discovery.conflicts || [];
    return {
        applied: true,
        strategy,
        reason: 'discovery',
        candidates,
        claims: claimsFromCandidates(candidates, usedConflicts),
        conflicts: usedConflicts,
        final_instruction: RECOVERY_FINAL_INSTRUCTIONS[strategy],
    };
}

const RECOVERY_FINAL_INSTRUCTIONS = Object.freeze({
    [RECOVERY_STRATEGIES.NEAREST_CONFIRMED_FACT]:
        'The exact fact asked for is not currently confirmed, but related confirmed facts about the same subject appear below. Share the closest confirmed facts in your own warm sommelier voice, and keep the specific missing value honestly unconfirmed -- never invent it. Do not mention any database, search, or internal tool. Two short natural sentences in the user\'s language.',
    [RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY]:
        'The user described something subjective (unusual, rare, young, family-made, small...). Treat that as a preference to explore, not a verified fact. Recommend 1-3 confirmed options below as suggestions they may enjoy. Do not claim any of them objectively is "the most unusual" or "the best" unless the evidence says so, and do not invent attributes. Do not mention any database, search, or internal tool. Two short natural sentences in the user\'s language.',
    [RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES]:
        'The exact producer or wine the user named cannot be confirmed. Offer 1-3 confirmed alternatives from the options below, framed as alternatives to explore. Never state facts about the unconfirmed original. Do not mention any database, search, or internal tool. Two short natural sentences in the user\'s language.',
    [RECOVERY_STRATEGIES.PARTIAL_EVIDENCE]:
        'Only part of this question can be confirmed right now. Answer exactly that confirmed part from the evidence below, in your own warm sommelier voice, and softly note the rest is not confirmed yet. Do not invent the unconfirmed part. Do not mention any database, search, or internal tool. Two short natural sentences in the user\'s language.',
    [RECOVERY_STRATEGIES.HONEST_LIMITATION]:
        'You cannot confirm this exact detail right now, and you must not invent it. Say so honestly and warmly in your own sommelier voice -- without mentioning any database, search, or internal tool -- then offer one genuinely useful next step (an adjacent style, grape, region, producer, or a different question). Two short spoken sentences, never a sentence that sounds like a system error or a database report.',
});

const DEAD_END_FINAL_INSTRUCTION = RECOVERY_FINAL_INSTRUCTIONS[RECOVERY_STRATEGIES.HONEST_LIMITATION];

module.exports = {
    RECOVERY_STRATEGIES,
    RECOVERY_FINAL_INSTRUCTIONS,
    DEAD_END_FINAL_INSTRUCTION,
    RECOVERY_MAX_CANDIDATES,
    couldRecover,
    classifyStrategy,
    pickCandidates,
    attemptRecovery,
    buildDiscoveryQuery,
    stripAlternativeTarget,
    stripSubjective,
    discoveryTokens,
    languageOf,
    normalize,
};
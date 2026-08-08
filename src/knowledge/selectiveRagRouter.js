'use strict';
/*
 * SELECTIVE RAG ROUTER -- "should we run retrieval for this query at all?"
 *
 * This is a DIFFERENT and EARLIER decision than the answerability gate in
 * layeredRouter.js. The gate asks, after retrieval has run, "can this evidence
 * be trusted / may the assistant answer". This module asks, before anything
 * runs, "is retrieval worth doing". The gate is untouched by this file and
 * still applies to every GROUNDED turn.
 *
 * Design constraints:
 *  - pure and synchronous. No LLM call, no I/O, no await. A routing decision
 *    that itself costs a model round-trip cannot pay for the latency it is
 *    trying to save.
 *  - reuses the discriminators the answerability gate already uses
 *    (SPECIFIC_ATTRIBUTE_RE, GENERAL_EXPLANATION_RE, resolveEntity(), the
 *    unknown-proper-entity heuristic) rather than restating them, so the two
 *    layers cannot drift apart on safety-critical inputs.
 *  - asymmetric by construction. A false DIRECT (we skipped retrieval on a
 *    query that needed it) can produce a confidently wrong statement about a
 *    real producer's price, vintage or award. A false GROUNDED costs ~8s of
 *    latency and some tokens. Every node is ordered and written so that
 *    uncertainty resolves toward GROUNDED.
 *  - never returns AMBIGUOUS. Ambiguity is a property of the dataset labels,
 *    not of the runtime contract; at runtime ambiguity means GROUNDED.
 *
 * Nothing here is wired into the live tool path. Offline evaluation only.
 */

const {
    isFreshnessQuery,
    isCatalogQuery,
    SPECIFIC_ATTRIBUTE_RE,
    GENERAL_EXPLANATION_RE,
    GRAPE_VARIETY_RE,
    NON_ENTITY_PROPER_NOUN_RE,
    _isWineRelated: isWineRelated,
    normalize,
} = require('./layeredRouter');
const { resolveEntity } = require('./entityResolver');

const PATHS = Object.freeze({ DIRECT: 'DIRECT', GROUNDED: 'GROUNDED' });

// ---------------------------------------------------------------------------
// Local discriminators. Everything here is a signal the existing modules do
// NOT already provide; anything they DO provide is imported above.
// ---------------------------------------------------------------------------

// "что у вас есть", "из вашего ассортимента", "порекомендуй из ваших".
// isCatalogQuery() only catches price/stock/buy vocabulary, so a first-person-
// plural inventory question ("Что из вашего ассортимента подойдёт к стейку?")
// slips past it and reads as a general food-pairing question -- which it is
// NOT: it asks us to name products we actually stock.
const OUR_INVENTORY_RE = /(у вас|ваш[аеиуго]*\s*(ассортимент|вин|коллекц|линейк|погреб|каталог)|ассортимент|в наличии|у нас есть|что посоветуете из|из ваших|do you (have|carry|stock)|your (range|selection|portfolio|catalogue|catalog)|aveți|în stoc|gama voastr)/iu;

// Wine + food pairing asked in the abstract. Deliberately narrow: it fires on
// pairing vocabulary, and the node that uses it runs AFTER every entity and
// inventory node, so "что подать к стейку у Purcari" never reaches it.
const FOOD_PAIRING_RE = /(подойд[её]т к|подать к|сочетает|сочетани|в пар[еу] с|к какому блюд|к мясу|к рыбе|к сыру|к десерт|под стейк|под рыбу|гастрономическ|pair(s|ing)? with|goes with|match(es)? with|se potrivește|asociere)/iu;

// Small talk / meta / no factual content. Retrieval has nothing to look up.
// NB: no trailing \b. JavaScript's \b is ASCII-oriented, so `спасибо\b` does
// NOT match "Спасибо," -- there is no ASCII word boundary between a Cyrillic
// letter and a comma. This module hit that exact bug; the explicit terminator
// class below is the fix (layeredRouter.js carries the same warning).
const SMALLTALK_RE = /^(привет|здравствуй|добрый (день|вечер|утро)|салют|hi|hello|hey|bun[ăa] (ziua|seara)|salut|спасибо|благодарю|thanks|thank you|mulțumesc|пока|до свидания|bye|ок|okay|ладно|как дела|how are you|кто ты|что ты умеешь|who are you|what can you do|ce poți)(\s|[,.!?…]|$)/iu;

// --- False-positive guards on the imported discriminators -------------------
// These exist because layeredRouter's regexes are tuned for a POST-retrieval
// safety gate, where over-firing only makes the assistant more careful. Here,
// over-firing destroys the entire benefit of the router, so the specific
// promiscuous stems are guarded. Each guard is narrow and named.

// isFreshnessQuery() matches the stems `открыт` and `час` (intended: "opening
// hours"). In Russian those also occur in "открытую бутылку" (an OPENED
// bottle), "часто" (often) and "часть" (part) -- none of which are freshness
// questions. Fire the guard only when no genuinely commercial/temporal token
// is present.
const FRESHNESS_PROMISCUOUS_ONLY_RE = /^(?:(?!цена|стоим|стоит|налич|купить|заказать|расписан|график|режим работы|часы работы|новост|событ|сейчас|актуальн|price|stock|buy|schedule|opening hours|current|preț|stoc|program|eveniment).)*$/isu;
const FRESHNESS_SOFT_STEMS_RE = /(открыт|часто|части|часть)/iu;
// isCatalogQuery() matches `бутылк` and `фото` (intended: "a photo of the
// bottle", i.e. a catalog card). "Как хранить открытую бутылку вина?" is not a
// catalog lookup. Same guard, same reasoning.
const CATALOG_SOFT_STEMS_RE = /(бутылк|бутылок|фото)/iu;

// GENERAL_EXPLANATION_RE requires "чем отлич" as an adjacent pair, so
// "Чем Каберне Совиньон отличается от Мерло?" (subject between the two words)
// does not match. It also has no yes/no-question or serving-technique shape.
const GENERAL_EXPLANATION_EXTRA_RE = /(отлича[её]тся|отличают|разниц|сравни|лучше или|или лучше|стоит ли|можно ли|нужно ли|правда ли|все ли|бывает ли|обязательно ли|имеет ли смысл|при какой температур|как долго|сколько хранит|как хранит|как подавать|как пить|что даёт|что дает|зачем нужн|is it|are all|do all|should i|can i|what are|ce sunt|ce înseamnă|how long|how should|what does .* do|which is better)/iu;

// Pairing asked in the abstract, phrased without an explicit pairing verb.
const FOOD_PAIRING_EXTRA_RE = /(^|\s)(какое вино (к|с|под|для)|что (налить|пить|выпить|взять) (к|с|под)|что подойд[её]т (к|под)|к (суши|роллам|пасте|пицц|птице|утке|курице|баранине|дичи|грибам|салат|устриц|морепродукт|шоколад|стейку|барбекю|шашлык|плову|фуа)|к (острой|жирной|азиатской|индийской|мексиканской|итальянской) кухне|кухне\b|с шоколадн|с десерт)/iu;

// Visits, tours, tastings, booking. These read as general advice ("Нужно ли
// бронировать визит заранее?") but the useful answer is operational fact about
// real wineries -- booking policy, opening days, tour length, price. Getting it
// wrong sends a user to a closed gate, so it is never DIRECT.
const VISIT_LOGISTICS_RE = /(бронир|заказать визит|записаться|визит на виноде|экскурс|посетить виноде|дегустацион|дегустаци[юияей]|можно ли приехать|как добраться|book(ing)?\b|reservation|\btours?\b|visit(ing)? (the )?winer|tasting room|rezerv|vizit|excursi|degustare)/iu;

// Moldovan dishes. A pairing question about local cuisine is, in this product,
// effectively "recommend from our Moldovan range" -- the useful answer names
// bottles we actually carry. Grounded, not general.
const LOCAL_CUISINE_RE = /(мамалыг|мэмэлиг|mămăligă|mamaliga|плацинд|plăcint|placint|брынз|brânz|branz|сарма|sarmale|зама\b|zeamă|муждей|mujdei|răcitur|качамак)/iu;

// Wine-topic widening. _isWineRelated() is tuned for web-search routing and
// misses technical/inflected vocabulary; a question naming a grape variety is
// self-evidently wine-topical, so GRAPE_VARIETY_RE doubles as a topic signal.
const WINE_STYLE_TOPIC_RE = /(blanc|noir|brut|sec\b|demi-sec|rose|ros[ée]|spumant|soi(?:ul|uri)?\b|struguri|pahar|bocal|виноград|погреб|бутылк|urcior)/iu;

// Grape and place names that the imported GRAPE_VARIETY_RE /
// NON_ENTITY_PROPER_NOUN_RE lists do not yet cover, and that were observed
// producing false "unknown proper entity" hits. Extending the shared lists
// would change the answerability gate's behaviour, which is out of scope, so
// the additions are applied locally.
const EXTRA_NON_ENTITY_RE = /(grand cru|premier cru|m[ée]thode traditionnelle|methode traditionnelle|traditionnelle|charmat|cru\\b|reserva|riserva|brut nature|extra brut|blanc de blancs|blanc de noirs|нуар|нягр[эаы]|бланк?\b|гри\b|блан\b|шампенуаз|шарма|charmat|метод[аеу]?\b|света\b|свет[аеу]?\b|старого|нового|бургунди|орегон|oregon|тоскан|напа|napa|эльзас|мозел|mosel|дору|douro|риоха|тайск|thai|индийск|indian|японск|japanese|китайск|мексиканск|итальянск|французск|испанск|азиатск|европейск|америк|american|восточн|западн|южн|северн)/giu;

function stripNonEntityVocabulary(query) {
    return String(query || '')
        .replace(GRAPE_VARIETY_RE, ' ')
        .replace(NON_ENTITY_PROPER_NOUN_RE, ' ')
        .replace(EXTRA_NON_ENTITY_RE, ' ');
}

// Stricter re-implementation of layeredRouter's _looksLikeUnknownProperEntity.
// Same intent -- "is there a proper-noun-shaped token the registry does not
// know?" -- with two corrections that matter only on this side:
//   1. Sentence-initial capitals are grammatical, not referential. The shared
//      version skips only token 0; it therefore reads "Как" in "Привет! Как
//      дела?" as a proper noun. Here, any token following . ! ? … is skipped.
//   2. A quoted span is an entity signal only if the quoted text is
//      capitalised. «терруар» and «ножки» are quoted common nouns, not brands.
// Both corrections REDUCE firing, so each one was checked against the
// unknown_entity category of the router dataset (8 invented producers), all of
// which still fire.
function looksLikeUnknownProperEntityStrict(query) {
    const stripped = stripNonEntityVocabulary(query);
    const quoted = stripped.match(/["«„]\s*([^"»“]{1,60})/u);
    if (quoted && /^[A-ZА-ЯЁĂÂÎȘȚ]/u.test(quoted[1].trim())) return true;
    // Split into sentences so every sentence-initial token can be skipped.
    return stripped
        .split(/[.!?…]+/u)
        .some((sentence) => sentence
            .split(/[\s,;:()"'«»]+/u)
            .filter(Boolean)
            .slice(1)
            .some((token) => /^[A-ZА-ЯЁĂÂÎȘȚ][\p{L}-]+$/u.test(token)));
}

// Extra oenology vocabulary. Mirrors the same widening classifyClaimDependency()
// applies locally for exactly the same reason: _isWineRelated() is tuned for
// web-search routing and misses inflected/technical terms.
const WINE_TOPIC_EXTRA_RE = /(vin(?:ul|uri|urile)?\b|decant|танин|tanin|tannin|кислотност|aciditate|acidity|купаж|blend|терпк|послевкус|аромат|бро[жд]ени|фермент|ferment|дуб[ае]\b|oak|бокал|glass|температур подач|serving temperature|сомелье|урожайност|органическ вино|биодинам|biodynamic|сульфит|sulphite|sulfite|игрист|sparkling|шампанизац|розов вино|ros[ée]|крепл|порт|херес|sherry|мадер)/iu;

// Referent-dependent follow-up. Same shape as the REFERENT_DEPENDENT_RE that
// src/tools/searchLayeredKnowledge.js already uses to decide when to prepend
// prior turns to the retrieval query -- this router asks the same question one
// step earlier ("does this turn even have a referent of its own?").
const REFERENT_DEPENDENT_RE = /(^|\s)(их|них|него|не[её]|это|этих|этот|эта|эти|этого|том|тот|та|те|оно|он|она|они|acest|acel|ele|ei|them|it|this|that|those)(\s|$|[,?.!])/iu;
const SHORT_FOLLOWUP_MAX_CHARS = 60;
const SHORT_FOLLOWUP_OPENER_RE = /^(а|и|но|ещ[её]|тогда|okay|ok|and|but|iar|și)\b/iu;

// "что такое X", "что это за X", "what is X" are DEFINITIONAL openers, not
// anaphora. The shared searchLayeredKnowledge regex includes такое/такой and
// treats them as referents, which is harmless there (it only widens the
// retrieval query) but here made every "Что такое танины?" look like a
// follow-up about a previous entity.
// A leading connective is allowed: "А что такое танины вообще?" is a clean
// topic switch to a definition, not a follow-up about the previous entity.
const DEFINITIONAL_OPENER_RE = /^(?:(?:а|и|но|ок|okay|ok|and|iar)[\s,]+)?(что такое|что это за|что означает|что значит|what is|what's|what are|ce este|ce sunt|ce înseamnă)/iu;

function looksReferentDependent(query) {
    const text = String(query || '').trim();
    if (!text) return false;
    if (DEFINITIONAL_OPENER_RE.test(text)) return false;
    if (REFERENT_DEPENDENT_RE.test(text)) return true;
    return text.length <= SHORT_FOLLOWUP_MAX_CHARS && SHORT_FOLLOWUP_OPENER_RE.test(text);
}

// resolveEntity() must never be able to make this router LESS conservative:
// if the resolver throws, we report "unresolved", and the unknown-proper-entity
// node below still catches proper-noun-shaped queries.
function safeResolve(query, resolveEntityFn) {
    try {
        const r = resolveEntityFn(String(query || ''));
        return r && r.found ? r : null;
    } catch (error) {
        console.warn('[selectiveRagRouter] entity resolution failed, treating as unresolved: %s', error?.message);
        return null;
    }
}

function decision(path, reason, entity, confidence) {
    return { path, reason, entity: entity || null, confidence };
}

// ---------------------------------------------------------------------------
// Decision nodes. Each is a small named predicate returning either a decision
// or null ("this node does not apply, fall through"). Order is load-bearing
// and is asserted by NODE_ORDER below.
// ---------------------------------------------------------------------------

// N1 CURRENT_DATA -- price, stock, availability, opening hours, events, "now".
// First because it outranks everything else: a freshness question is never
// answerable from model priors no matter how general its phrasing looks.
function nodeCurrentData(ctx) {
    if (isCatalogQuery(ctx.query)) {
        const promiscuousOnly = CATALOG_SOFT_STEMS_RE.test(ctx.norm)
            && FRESHNESS_PROMISCUOUS_ONLY_RE.test(ctx.norm);
        if (!promiscuousOnly) {
            return decision(PATHS.GROUNDED, 'CURRENT_DATA:catalog', ctx.entity?.canonicalName, 0.99);
        }
    }
    if (isFreshnessQuery(ctx.query)) {
        // Guard: suppress when the ONLY thing that matched is a promiscuous
        // stem (открыт/часто/часть) and no commercial or temporal token is
        // present. "Как хранить открытую бутылку вина?" is not a freshness
        // question.
        const promiscuousOnly = FRESHNESS_SOFT_STEMS_RE.test(ctx.norm)
            && FRESHNESS_PROMISCUOUS_ONLY_RE.test(ctx.norm);
        if (!promiscuousOnly) {
            return decision(PATHS.GROUNDED, 'CURRENT_DATA:freshness', ctx.entity?.canonicalName, 0.99);
        }
    }
    return null;
}

// N2 OUR_INVENTORY -- "what do you have", "from your range". Asks us to name
// products we actually stock; model priors do not know our shelf.
function nodeOurInventory(ctx) {
    if (OUR_INVENTORY_RE.test(ctx.norm)) {
        return decision(PATHS.GROUNDED, 'OUR_INVENTORY:asks_our_range', ctx.entity?.canonicalName, 0.97);
    }
    return null;
}

// N2b VISIT_LOGISTICS -- tours, tastings, booking, getting there. Operational
// facts about real venues, even when phrased as generic advice.
function nodeVisitLogistics(ctx) {
    if (VISIT_LOGISTICS_RE.test(ctx.norm)) {
        return decision(PATHS.GROUNDED, 'VISIT_LOGISTICS:operational_fact', ctx.entity?.canonicalName, 0.94);
    }
    return null;
}

// N3 ENTITY_REFERENCE -- the query names a producer/product in the 109-entity
// registry. Unconditionally GROUNDED, including for comparative or
// general-sounding phrasings ("Какие вина легче -- Purcari или обычные
// молдавские?"). Reasoning: any answer to such a question necessarily makes an
// attributed claim about that named producer's wines, and an attributed claim
// from priors is precisely the severity-10 failure this router exists to avoid.
// The registry is also the only signal that survives typos -- resolveEntity()
// does fuzzy matching, so "Пуркари"/"Purkari"/"Vinaria din Vale" resolve where
// a substring match would not.
function nodeEntityReference(ctx) {
    if (ctx.entity) {
        return decision(
            PATHS.GROUNDED,
            `ENTITY_REFERENCE:${ctx.entity.matchType || 'resolved'}`,
            ctx.entity.canonicalName,
            0.96,
        );
    }
    return null;
}

// N4 UNKNOWN_PROPER_ENTITY -- proper-noun-shaped, but the registry does not
// know it. The registry holds 109 entities; Moldova has hundreds of producers,
// and users invent or misremember names. An unresolved proper noun is the
// single most dangerous input for a DIRECT answer: the model will happily
// narrate the history of a winery that does not exist. Always GROUNDED, so the
// answerability gate downstream can produce an honest "cannot confirm".
function nodeUnknownProperEntity(ctx) {
    if (looksLikeUnknownProperEntityStrict(ctx.query)) {
        return decision(PATHS.GROUNDED, 'UNKNOWN_PROPER_ENTITY:unresolved_proper_noun', null, 0.90);
    }
    return null;
}

// N5 SPECIFIC_ATTRIBUTE -- asks for a checkable value (ABV, vintage, award,
// winemaker, founding year, rating, address). Even with no entity named, these
// are record lookups, not explanations.
function nodeSpecificAttribute(ctx) {
    if (!SPECIFIC_ATTRIBUTE_RE.test(ctx.norm)) return null;
    // Bounded exemption: an attribute WORD with no subject is education, not a
    // record lookup. "Что даёт вину выдержка в дубовой бочке?" uses `выдерж`
    // but asks how ageing works. By the time this node runs, ENTITY_REFERENCE
    // and UNKNOWN_PROPER_ENTITY have both declined, so the query provably
    // names nothing -- there is no producer whose attribute could be invented.
    // The digit test keeps the exemption honest: any number in the question
    // ("Почему урожай 2019 считается лучшим?") means a specific record is
    // being asked about, and stays GROUNDED.
    const isExplanationShaped = GENERAL_EXPLANATION_RE.test(ctx.norm) || GENERAL_EXPLANATION_EXTRA_RE.test(ctx.norm);
    const hasDigits = /\d/u.test(ctx.norm);
    if (isExplanationShaped && !hasDigits && ctx.wineTopic) return null;
    return decision(PATHS.GROUNDED, 'SPECIFIC_ATTRIBUTE:checkable_value', ctx.entity?.canonicalName, 0.92);
}

// N6 CONVERSATION_ENTITY_CONTEXT -- multi-turn referent. "А какое из них
// легче?" names nothing, so N3/N4 cannot fire, but the turn inherits an entity
// from the conversation. Reuses the EXISTING recentTurns mechanism (the same
// array realtimeServer.js already puts in toolContext) -- no new memory system.
// Gated on referent-dependence, not merely on "a prior turn had an entity":
// otherwise "А что такое танины?" after a Purcari turn would be forced
// GROUNDED for no reason.
function nodeConversationEntityContext(ctx) {
    if (!looksReferentDependent(ctx.query)) return null;
    // No history means there is no referent to inherit. On a first turn a
    // pronoun is almost always non-anaphoric ("всегда ли ЭТО нужно?"), and
    // every entity/attribute/freshness node has already declined, so there is
    // nothing for this node to protect. Fall through rather than forcing
    // GROUNDED on turn 1 -- the AMBIGUOUS terminal still catches anything the
    // general-knowledge node cannot positively classify.
    if (!ctx.recentTurns.length) return null;
    const priorUserText = ctx.recentTurns
        .filter((t) => t && t.role === 'user' && String(t.text || '').trim())
        .map((t) => String(t.text).trim())
        .slice(-2)
        .join(' ');
    const contextEntity = priorUserText ? safeResolve(priorUserText, ctx.resolveEntityFn) : null;
    if (contextEntity) {
        return decision(
            PATHS.GROUNDED,
            'CONVERSATION_ENTITY_CONTEXT:inherited_entity',
            contextEntity.canonicalName,
            0.93,
        );
    }
    const priorAll = ctx.recentTurns.map((t) => String(t?.text || '')).join(' ');
    if (isCatalogQuery(priorAll) || isFreshnessQuery(priorAll) || SPECIFIC_ATTRIBUTE_RE.test(normalize(priorAll))) {
        return decision(PATHS.GROUNDED, 'CONVERSATION_ENTITY_CONTEXT:inherited_grounded_topic', null, 0.80);
    }
    return decision(PATHS.GROUNDED, 'CONVERSATION_ENTITY_CONTEXT:unresolved_referent', null, 0.72);
}

// N7 SMALLTALK -- greetings, thanks, "who are you". No factual content, so
// there is nothing for retrieval to find. Runs after every grounding node so
// that "Привет! Сколько стоит Negru de Purcari?" is still GROUNDED.
function nodeSmalltalk(ctx) {
    if (SMALLTALK_RE.test(ctx.query.trim())) {
        return decision(PATHS.DIRECT, 'SMALLTALK:no_factual_content', null, 0.94);
    }
    return null;
}

// N8 GENERAL_WINE_KNOWLEDGE -- the only node that can return DIRECT for a
// factual question. Requires ALL of: wine topic, explanation-or-pairing shape,
// and (by virtue of running last) no entity, no unresolved proper noun, no
// specific attribute, no freshness, no inventory framing, no dangling referent.
function nodeGeneralWineKnowledge(ctx) {
    if (!ctx.wineTopic) return null;
    if (GENERAL_EXPLANATION_RE.test(ctx.norm) || GENERAL_EXPLANATION_EXTRA_RE.test(ctx.norm)) {
        return decision(PATHS.DIRECT, 'GENERAL_WINE_KNOWLEDGE:explanation', null, 0.88);
    }
    if (ctx.isPairing) {
        return decision(PATHS.DIRECT, 'GENERAL_WINE_KNOWLEDGE:food_pairing', null, 0.85);
    }
    return null;
}

// N8b -- food pairing with no wine vocabulary at all ("Что подать к стейку?").
// Still a general sommelier question; the pairing patterns are specific enough
// that they cannot fire on an entity or price question, both of which exited
// earlier, and local-cuisine pairings were excluded when ctx.isPairing was
// computed.
function nodeGeneralPairingNoWineVocab(ctx) {
    if (ctx.isPairing) {
        return decision(PATHS.DIRECT, 'GENERAL_WINE_KNOWLEDGE:food_pairing_implicit', null, 0.80);
    }
    return null;
}

// N9 AMBIGUOUS -- terminal fallback. Never DIRECT. Anything that reached here
// is a factual-looking question the router could not positively classify as
// safe general knowledge, and "we are not sure" must cost latency, not
// accuracy.
function nodeAmbiguousFallback() {
    return decision(PATHS.GROUNDED, 'AMBIGUOUS:default_grounded', null, 0.50);
}

const NODE_ORDER = Object.freeze([
    ['CURRENT_DATA', nodeCurrentData],
    ['OUR_INVENTORY', nodeOurInventory],
    ['VISIT_LOGISTICS', nodeVisitLogistics],
    ['ENTITY_REFERENCE', nodeEntityReference],
    ['UNKNOWN_PROPER_ENTITY', nodeUnknownProperEntity],
    ['SPECIFIC_ATTRIBUTE', nodeSpecificAttribute],
    ['CONVERSATION_ENTITY_CONTEXT', nodeConversationEntityContext],
    ['SMALLTALK', nodeSmalltalk],
    ['GENERAL_WINE_KNOWLEDGE', nodeGeneralWineKnowledge],
    ['GENERAL_WINE_KNOWLEDGE_IMPLICIT', nodeGeneralPairingNoWineVocab],
    ['AMBIGUOUS', nodeAmbiguousFallback],
]);

/**
 * @param {string} query        the current user turn, verbatim
 * @param {object} [options]
 * @param {Array<{role:string,text:string}>} [options.recentTurns] existing
 *        realtime conversation buffer -- same array shape as toolContext
 * @param {Function} [options.resolveEntityFn] injectable for tests
 * @returns {{path:'DIRECT'|'GROUNDED', reason:string, entity:?string, confidence:number}}
 */
function routeSelective(query, options = {}) {
    const text = String(query == null ? '' : query);
    const resolveEntityFn = options.resolveEntityFn || resolveEntity;
    if (!text.trim()) {
        return decision(PATHS.GROUNDED, 'AMBIGUOUS:empty_query', null, 0.50);
    }
    const norm = normalize(text);
    const ctx = {
        query: text,
        norm,
        recentTurns: Array.isArray(options.recentTurns) ? options.recentTurns : [],
        resolveEntityFn,
        entity: safeResolve(text, resolveEntityFn),
        // Naming a grape variety is by itself proof the question is about wine.
        wineTopic: isWineRelated(text)
            || WINE_TOPIC_EXTRA_RE.test(norm)
            || WINE_STYLE_TOPIC_RE.test(norm)
            || text.replace(GRAPE_VARIETY_RE, ' ') !== text,
        // A Moldovan-dish pairing is really "recommend from our range" -- the
        // useful answer names bottles we carry, so it is NOT general knowledge.
        isPairing: (FOOD_PAIRING_RE.test(norm) || FOOD_PAIRING_EXTRA_RE.test(norm))
            && !LOCAL_CUISINE_RE.test(norm),
    };
    for (const [name, node] of NODE_ORDER) {
        const result = node(ctx);
        if (result) {
            // Hard invariant: no node may ever emit AMBIGUOUS as a runtime path.
            if (result.path !== PATHS.DIRECT && result.path !== PATHS.GROUNDED) {
                return decision(PATHS.GROUNDED, `INVARIANT_VIOLATION:${name}`, null, 0.50);
            }
            return result;
        }
    }
    return nodeAmbiguousFallback();
}

module.exports = {
    routeSelective,
    PATHS,
    NODE_ORDER,
    // exported for targeted tests / eval breakdowns
    nodeCurrentData,
    nodeOurInventory,
    nodeVisitLogistics,
    nodeEntityReference,
    nodeUnknownProperEntity,
    nodeSpecificAttribute,
    nodeConversationEntityContext,
    nodeSmalltalk,
    nodeGeneralWineKnowledge,
    looksReferentDependent,
    OUR_INVENTORY_RE,
    FOOD_PAIRING_RE,
    SMALLTALK_RE,
};

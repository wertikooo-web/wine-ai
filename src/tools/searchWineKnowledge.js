'use strict';

const { search } = require('../knowledge/search');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_wine_knowledge',
    description: 'Search the Moldovan wine knowledge base for factual information. Call this before answering any factual question about wines, wineries, grape varieties, regions, or wine tourism — never answer from memory alone. Returns relevant fragments with their source.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'The factual question or topic to search for. This is matched by literal keyword AND meaning — it is NOT purely semantic, so exact wording matters. Keep any proper noun, product/package name, brand, or capitalized term EXACTLY as the user wrote it — same script, same spelling, same capitalization. Do NOT translate, transliterate, or paraphrase these terms (e.g. if the user wrote "KOSHER" in Latin letters, the query must contain "KOSHER" in Latin letters too, not a Cyrillic translation like "кошерные" — those will not match the same source text). You may add surrounding context words in the user\'s language, but never alter the exact term itself.',
            },
            language: { type: 'STRING', description: 'Optional ISO language code (ru, ro, en) to prefer for results.' },
        },
        required: ['query'],
    },
};

const RU_ONES = { 'один': 1, 'два': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9 };
const RU_ONES_REV = { 1: 'один', 2: 'два', 3: 'три', 4: 'четыре', 5: 'пять', 6: 'шесть', 7: 'семь', 8: 'восемь', 9: 'девять' };

// Bounded, deterministic query variant generation for named-entity/numeral
// phrasing mismatches — e.g. "Семь тысяч лет вина" vs a source titled
// "7000 лет с вином": neither plain keyword nor embedding similarity
// reliably bridges spelled-out vs numeral forms of the same number, so this
// tries both directions explicitly rather than hoping semantic search closes
// the gap. Deliberately small and rule-based, not a second LLM call — see
// docs/ARCHITECTURE.md's "Tools" section on why tools stay dependency-light.
function buildQueryVariants(originalQuery) {
    const variants = [originalQuery];
    const seen = new Set([originalQuery]);
    const add = (variant) => {
        const trimmed = variant.trim().replace(/\s+/g, ' ');
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            variants.push(trimmed);
        }
    };

    // Strip surrounding quote characters (the phrase itself, not the tool
    // query text) — a title quoted by the user often isn't quoted in the
    // source document.
    add(originalQuery.replace(/["'«»“”]/g, ''));

    // Spelled-out "N тысяч" -> digit "N000" (handles "семь тысяч" -> "7000").
    // Note: plain \b word-boundary assertions do not work reliably around
    // Cyrillic text (\b is defined in terms of the ASCII-only \w class), so
    // these use explicit Unicode-aware lookaround instead.
    const spelledThousands = originalQuery.replace(
        /(?<![\p{L}\p{N}])(один|два|три|четыре|пять|шесть|семь|восемь|девять)\s+тысяч\w*(?![\p{L}\p{N}])/giu,
        (match, word) => `${RU_ONES[word.toLowerCase()]}000`
    );
    add(spelledThousands);

    // Digit "N000" -> spelled "N тысяч" (handles "7000" -> "семь тысяч").
    const digitThousands = originalQuery.replace(
        /(?<![\p{L}\p{N}])([1-9])000(?![\p{L}\p{N}])/gu,
        (match, digit) => `${RU_ONES_REV[Number(digit)]} тысяч`
    );
    add(digitThousands);

    // "N тысяч" -> "N тыс." numeral-adjacent short form some source titles use.
    const shortThousands = originalQuery.replace(
        /(?<![\p{L}\p{N}])([1-9])\s*000(?![\p{L}\p{N}])/gu,
        (match, digit) => `${digit} тыс.`
    );
    add(shortThousands);

    // Strip generic interrogative/filler words to leave the core entity
    // phrase — "что такое проект X" / "расскажи про X" -> "X".
    const stopwordStripped = originalQuery
        .replace(/\b(что\s+такое|расскажи(те)?\s+про|расскажи(те)?\s+о|проект|это)\b/giu, ' ')
        .replace(/[?.!]/g, '');
    add(stopwordStripped);

    // Bounded: original + at most 4 fallbacks, never unbounded expansion.
    return variants.slice(0, 5);
}

async function runBoundedRetrieval(query, { language }) {
    const attempts = [];
    let bestHits = [];
    let bestEntityContext = null;
    let sawSuccessfulAttempt = false;

    for (const normalizedQuery of buildQueryVariants(query)) {
        let result;
        try {
            result = await search(normalizedQuery, { language, limit: 6 });
            sawSuccessfulAttempt = true;
        } catch {
            attempts.push({ normalizedQuery, hitCount: 0, mode: 'error' });
            continue;
        }
        attempts.push({ normalizedQuery, hitCount: result.hits.length, mode: result.mode });
        if (result.entityContext && !bestEntityContext) {
            bestEntityContext = result.entityContext;
        }
        if (result.hits.length > 0) {
            bestHits = result.hits;
            break;
        }
    }

    const finalStatus = bestHits.length > 0 ? 'found' : (sawSuccessfulAttempt ? 'not_found' : 'error');
    return { attempts, hits: bestHits, entityContext: bestEntityContext, finalStatus };
}

async function impl(args) {
    const query = requireNonEmptyString(args.query, 'query');
    const language = optionalString(args.language, 8) || null;
    const { attempts, hits, entityContext, finalStatus } = await runBoundedRetrieval(query, { language });

    // Diagnostic logging (P2 from docs/KNOWLEDGE_RUNTIME_AUDIT.md) — the
    // only way to tell "the model didn't call this tool" apart from "it
    // called it and got nothing useful" apart from "it got a good hit and
    // still answered wrong" is to see the actual query text and what came
    // back, not guess from the final transcript. Now also records every
    // bounded fallback attempt, not just the winning one, so a NOT_FOUND
    // decision is auditable against the full attempt list rather than a
    // single query's raw result.
    console.log('[search_wine_knowledge]', JSON.stringify({
        query,
        language,
        finalStatus,
        attempts,
        hit_count: hits.length,
        top_hits: hits.slice(0, 4).map((h) => ({ title: h.chunk.metadata.title, source_file: h.chunk.metadata.source_file, score: h.score })),
    }));

    if (finalStatus === 'error') {
        return {
            found: false,
            status: 'error',
            results: [],
            instruction: 'The knowledge base search could not complete right now due to a technical issue. Do NOT tell the user this information does not exist — say you cannot reliably verify it at the moment.',
        };
    }

    if (finalStatus === 'not_found') {
        // Only reached after every bounded fallback variant genuinely
        // returned zero hits — see buildQueryVariants()/runBoundedRetrieval()
        // above — never on a single raw query's empty result.
        return {
            found: false,
            status: 'not_found',
            results: [],
            instruction: 'No information about this was found in the knowledge base, even after trying alternate phrasings of the same query. Tell the user you do not have this information in your knowledge base. Do NOT answer from your own general/pretrained knowledge instead — that would misrepresent an unverified guess as a sourced fact.',
        };
    }

    const results = [];
    if (entityContext) {
        results.push({
            text: entityContext,
            title: 'Entity Resolution',
            source: 'entity_resolver',
            confidence: 'high',
            language: 'en',
            relevance_score: 1,
        });
    }
    for (const { chunk, score } of hits) {
        results.push({
            text: chunk.text,
            title: chunk.metadata.title,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
            language: chunk.metadata.language,
            relevance_score: score,
        });
    }

    return {
        found: true,
        status: 'found',
        results,
    };
}

module.exports = { declaration, impl, buildQueryVariants };

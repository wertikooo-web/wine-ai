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

async function impl(args) {
    const query = requireNonEmptyString(args.query, 'query');
    const language = optionalString(args.language, 8) || null;
    const { hits, mode } = await search(query, { language, limit: 6 });

    // Diagnostic logging (P2 from docs/KNOWLEDGE_RUNTIME_AUDIT.md) — the
    // only way to tell "the model didn't call this tool" apart from "it
    // called it and got nothing useful" apart from "it got a good hit and
    // still answered wrong" is to see the actual query text and what came
    // back, not guess from the final transcript.
    console.log('[search_wine_knowledge]', JSON.stringify({
        query,
        language,
        mode,
        hit_count: hits.length,
        top_hits: hits.slice(0, 4).map((h) => ({ title: h.chunk.metadata.title, source_file: h.chunk.metadata.source_file, score: h.score })),
    }));

    if (hits.length === 0) {
        return { found: false, results: [] };
    }

    return {
        found: true,
        results: hits.map(({ chunk, score }) => ({
            text: chunk.text,
            title: chunk.metadata.title,
            source: chunk.metadata.source,
            confidence: chunk.metadata.confidence,
            language: chunk.metadata.language,
            relevance_score: score,
        })),
    };
}

module.exports = { declaration, impl };

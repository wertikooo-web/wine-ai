'use strict';

// Regression coverage for the "Семь тысяч лет вина" contradiction bug: the
// tool used to run exactly one query and immediately tell the model to say
// "not found" the instant that single query returned zero hits — even
// though a spelled-out-number vs digit phrasing mismatch (or a quoted title
// vs an unquoted source) meant a trivially different query would have found
// the same document. See src/tools/searchWineKnowledge.js's
// buildQueryVariants()/runBoundedRetrieval() for the fix: a bounded,
// deterministic set of query variants tried in order, with found/not_found/
// error only decided after all variants have run out or one succeeded.
const test = require('node:test');
const assert = require('node:assert/strict');
const { impl, buildQueryVariants } = require('../src/tools/searchWineKnowledge');

test('buildQueryVariants converts spelled-out thousands to digits and back, bounded to 5 variants', () => {
    const variants = buildQueryVariants('Семь тысяч лет вина');
    assert.ok(variants.includes('Семь тысяч лет вина'), 'keeps the original phrase');
    assert.ok(variants.some((v) => v.includes('7000')), 'must include a digit-normalized variant (7000)');
    assert.ok(variants.length <= 5, 'bounded to at most 5 variants, never unbounded expansion');

    const digitVariants = buildQueryVariants('Проект 7000 лет вина');
    assert.ok(digitVariants.some((v) => /семь\s+тысяч/i.test(v)), 'must include a spelled-out variant for a digit-form query');
});

test('search_wine_knowledge finds "Молдова — 7000 лет с вином" via bounded fallback for the exact reported phrase', async () => {
    // Uses the real, checked-in knowledge/source docs and index — same
    // convention as tests/knowledgeSearch.test.js. This is the literal
    // phrase from the reported bug ("Семь тысяч лет вина").
    const result = await impl({ query: 'Семь тысяч лет вина', language: 'ru' });
    assert.equal(result.found, true, 'must find the 7000-years-of-wine article via one of the bounded fallback variants');
    assert.equal(result.status, 'found');
    assert.ok(
        result.results.some((r) => /7000/.test(r.title)),
        'the found result set must include the "7000 лет с вином" article'
    );
});

test('search_wine_knowledge only reports not_found after every bounded variant genuinely returns zero hits', async () => {
    // Pure invented tokens, no real dictionary words — real words (even rare
    // ones) can still keyword-match somewhere in a ~2400-chunk corpus, and
    // semantic search always returns its top-K nearest neighbors regardless
    // of true relevance (see SEMANTIC_MAX_DISTANCE in src/knowledge/search.js),
    // so this needs to be genuinely unmatchable by either branch.
    const result = await impl({ query: 'жвыклбрп фнартоший клюздрап xyzzyqqqqz', language: 'ru' });
    assert.equal(result.found, false);
    assert.equal(result.status, 'not_found');
    assert.match(result.instruction, /alternate phrasings/, 'instruction must reflect that fallback variants were tried, not a single raw query');
});

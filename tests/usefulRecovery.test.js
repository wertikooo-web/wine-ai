'use strict';

// Unit contract for the Useful Answer Recovery layer
// (src/knowledge/usefulRecovery.js).
//
// Pins the anti-hallucination contract of recovery itself:
//   - recovery only fires on checked-and-failed (false) or checked-and-unknown
//     (null) answerability, never on a confident true, never on a caller that
//     opted out of the gate (undefined),
//   - every recoverable candidate is a real, provenance-carrying claim; web
//     evidence and low/unverified confidence are never recovered,
//   - recovery never flips answerable -- it only enriches what may be said,
//   - when the corpus has nothing supported, it returns an honest-limitation
//     dead end identical to the old refusal, never an invented value.

const assert = require('assert');
const tool = require('../src/tools/searchLayeredKnowledge');
const { routeKnowledgeWithAnswerabilityGate } = require('../src/knowledge/layeredRouter');
const {
    RECOVERY_STRATEGIES,
    RECOVERY_FINAL_INSTRUCTIONS,
    DEAD_END_FINAL_INSTRUCTION,
    couldRecover,
    classifyStrategy,
    pickCandidates,
    attemptRecovery,
    buildDiscoveryQuery,
} = require('../src/knowledge/usefulRecovery');

const LEVELS = Object.freeze({ DOCUMENTS: 'documents', CANONICAL: 'canonical', CATALOG: 'catalog', WEB: 'web' });

function item(index, { level = LEVELS.DOCUMENTS, confidence = 'medium', text = `Confirmed fact ${index} about Moldovan wine.`, title = `Fact ${index}`, source = `https://example.md/f-${index}` } = {}) {
    return { level, title, source, confidence, text, relevance_score: 0.7 };
}

// A discovery router stub: records the query it was given and returns the
// provided evidence for any query.
function stubRouter(evidence = [], calls = []) {
    return async (query) => {
        calls.push(query);
        return { found: evidence.length > 0, evidence, conflicts: [] };
    };
}

const groundResult = (overrides = {}) => ({
    found: true,
    answerable: false,
    claim_class: 'grounding_required',
    evidence_entity_match: 'not_applicable',
    evidence: [item(1), item(2)],
    conflicts: [],
    answerabilityReason: 'no specific value in evidence',
    ...overrides,
});

async function run() {
    console.log('Running Useful Answer Recovery Tests...');

    // ---------------------------------------------------------------- couldRecover ----
    assert.strictEqual(couldRecover(null), false);
    assert.strictEqual(couldRecover(undefined), false);
    assert.strictEqual(couldRecover({}), false, 'empty result must not recover');
    assert.strictEqual(couldRecover({ answerable: true }), false, 'a confirmed answer must not be replaced by recovery');
    assert.strictEqual(couldRecover({ answerable: false }), true, 'checked-and-failed opens recovery');
    assert.strictEqual(couldRecover({ answerable: null }), true, 'checked-and-unknown opens recovery');
    assert.strictEqual(couldRecover({ answerable: undefined }), false,
        'a caller that opted out of the gate (undefined) must not get recovery');
    assert.strictEqual(couldRecover({ answerable: false, claim_class: 'general_knowledge' }), false,
        'general-knowledge questions never need recovery');

    // ---------------------------------------------------------------- classifyStrategy ----
    assert.strictEqual(
        classifyStrategy(groundResult({ evidence_entity_match: 'match' }), 'question'),
        RECOVERY_STRATEGIES.PARTIAL_EVIDENCE,
        'retrieved-and-attributed but not answering evidence -> partial evidence');
    assert.strictEqual(
        classifyStrategy(groundResult({ evidence_entity_match: 'mismatch' }), 'question'),
        RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES,
        'a declared entity mismatch must never reuse the wrong producer\'s evidence');
    assert.strictEqual(
        classifyStrategy({ found: false, evidence: [] }, 'Что подать вместо Purcari к баранине?'),
        RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES);
    assert.strictEqual(
        classifyStrategy({ found: false, evidence: [] }, 'Какое необычное вино купить?'),
        RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY);
    assert.strictEqual(
        classifyStrategy({ found: false, evidence: [] }, 'Какой виноград у Castel Mimi?'),
        RECOVERY_STRATEGIES.NEAREST_CONFIRMED_FACT);

    // A discovery-framed request must not be flattened into partial evidence by
    // retrieved fragments: advice the user asked for outweighs the literal.
    assert.strictEqual(
        classifyStrategy(groundResult(), 'Посоветуй молодую малоизвестную молдавскую винодельню'),
        RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY);
    assert.strictEqual(
        classifyStrategy(groundResult(), 'Хочу что-нибудь необычное из Молдовы'),
        RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY);
    assert.strictEqual(
        classifyStrategy(groundResult(), 'Что попробовать вместо Purcari?'),
        RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES);
    assert.strictEqual(
        classifyStrategy(groundResult(), 'Recomandă o cramă mică și mai puțin cunoscută din Moldova'),
        RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY);
    // An entity mismatch stays supreme even inside a discovery-framed question.
    assert.strictEqual(
        classifyStrategy(groundResult({ evidence_entity_match: 'mismatch' }), 'Что-нибудь необычное вместо Purcari?'),
        RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES);
    // A partial pass REQUIRES the gate's "match" verdict: when the evidence
    // could not be attributed to the asked entity, recycling it would be the
    // wrong-entity attribution the gate forbids.
    assert.strictEqual(
        classifyStrategy(groundResult({ evidence_entity_match: 'match' }), 'Какова крепость Negru de Purcari 2019?'),
        RECOVERY_STRATEGIES.PARTIAL_EVIDENCE);
    assert.strictEqual(
        classifyStrategy(groundResult(), 'Какова крепость Negru de Purcari 2019?'),
        RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES,
        'unattributable evidence (no "match") must not be answered as the confirmed part');

    // ---------------------------------------------------------------- pickCandidates ----
    const picked = pickCandidates([
        item(1, { level: LEVELS.WEB, text: 'Web snippet that must never be recovered.' }),
        item(2),
        item(3, { confidence: 'low' }),
        item(4, { title: 'Fact 2', source: 'https://example.md/f-2' }), // duplicate of item(2)
        item(5, { level: LEVELS.CATALOG }),
    ], { allowedLevels: [LEVELS.DOCUMENTS] });
    assert.deepStrictEqual(
        picked.map((c) => c.title),
        ['Fact 2'],
        'web, low-confidence and out-of-mode items must be dropped; near-duplicates collapse');

    const capped = pickCandidates([item(1), item(2), item(3), item(4)], { max: 3 });
    assert.strictEqual(capped.length, 3, 'candidate count must be capped');

    // ---------------------------------------------------------------- partial evidence (D) ----
    {
        const result = await attemptRecovery({
            question: 'Какая крепость у Purcari Negru de Purcari 2019?',
            retrieval: groundResult({ evidence_entity_match: 'match' }),
        });
        assert.ok(result && result.applied === true);
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.PARTIAL_EVIDENCE);
        assert.strictEqual(result.candidates.length, 2);
        assert.strictEqual(result.claims.length, 2);
        assert.ok(result.claims.every((c) => c.kind === 'document_supported_fact' && c.source && (c.source.url || c.source.document_page)),
            'every recovered claim must be provenance-carrying');
        assert.strictEqual(result.final_instruction, RECOVERY_FINAL_INSTRUCTIONS[RECOVERY_STRATEGIES.PARTIAL_EVIDENCE]);
    }

    // explicit evidence override wins over retrieval.evidence
    {
        const result = await attemptRecovery({
            question: 'q',
            retrieval: groundResult({ evidence_entity_match: 'match' }),
            evidence: [item(9)],
        });
        assert.strictEqual(result.candidates.length, 1);
        assert.strictEqual(result.candidates[0].title, 'Fact 9');
    }

    // partial with nothing usable -> honest dead end, never invented
    {
        const result = await attemptRecovery({
            question: 'q',
            retrieval: groundResult({ evidence_entity_match: 'match', evidence: [item(3, { confidence: 'unverified' })] }),
        });
        assert.ok(result && result.applied === false);
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.HONEST_LIMITATION);
        assert.strictEqual(result.final_instruction, DEAD_END_FINAL_INSTRUCTION);
    }

    // a mismatch recovers via a discovery pass; also without a graded match a
    // partial would not be safe, revealing the alternativestrategy.
    {
        const calls = [];
        const result = await attemptRecovery({
            question: 'Какова крепость Negru de Purcari 2019?',
            retrieval: groundResult({ evidence_entity_match: 'not_applicable' }),
            discoveryRouter: stubRouter([item(8, { title: 'Alternative facts' })], calls),
        });
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES);
        assert.strictEqual(calls.length, 1, 'unattributable evidence -> one discovery pass for alternatives');
        assert.strictEqual(result.candidates[0].title, 'Alternative facts');
    }

    // ---------------------------------------------------------------- discovery (A/B/C) ----
    // nearest confirmed fact: reframed query reaches the router, candidates
    // are capped and mode-filtered.
    {
        const calls = [];
        const result = await attemptRecovery({
            question: 'Какой виноград у Castel Mimi?',
            language: 'ru',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: stubRouter([item(1), item(2), item(3), item(4)], calls),
            allowedLevels: [LEVELS.DOCUMENTS],
        });
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.NEAREST_CONFIRMED_FACT);
        assert.strictEqual(result.candidates.length, Math.min(4, 3));
        assert.strictEqual(result.candidates.length, 3, 'discovery candidates must be capped at 3');
        assert.strictEqual(calls.length, 1, 'one discovery pass, one router call');
    }

    // preference discovery strips the subjective modifier from the query.
    {
        const calls = [];
        await attemptRecovery({
            question: 'Какое необычное вино выбрать?',
            language: 'ru',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: stubRouter([item(1)], calls),
        });
        const reframed = calls[0];
        assert.strictEqual(reframed.toLowerCase().includes('необычное'), false,
            'the subjective modifier must not drive the discovery query');
    }

    // "вместо X" strips the unsupported target so alternatives are discoverable.
    {
        const calls = [];
        await attemptRecovery({
            question: 'Что подать вместо Purcari к баранине?',
            language: 'ru',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: stubRouter([item(1)], calls),
        });
        const reframed = calls[0];
        assert.strictEqual(reframed.toLowerCase().includes('purcari'), false,
            'the unsupported alternative target must not capsize the discovery query');
        assert.strictEqual(reframed, buildDiscoveryQuery('Что подать вместо Purcari к баранине?', 'ru'));
    }

    // entity-mismatch recovery runs a discovery pass instead of reusing the
    // wrong producer's evidence.
    {
        const calls = [];
        const result = await attemptRecovery({
            question: 'Кто главный винодел на винодельне Asconi?',
            retrieval: groundResult({
                evidence_entity_match: 'mismatch',
                evidence: [item(6, { title: 'Castel Mimi facts' })],
            }),
            discoveryRouter: stubRouter([item(7, { title: 'Alternative facts' })], calls),
        });
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.ENTITY_ALTERNATIVES);
        assert.strictEqual(result.candidates[0].title, 'Alternative facts',
            'a mismatch must discover alternatives, not reuse the mismatched evidence');
        assert.strictEqual(calls.length, 1);
    }

    // a discovery that yields nothing -> honest dead end, identical wording.
    {
        const result = await attemptRecovery({
            question: 'Полностью неизвестный вопрос',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: stubRouter([]),
        });
        assert.ok(result && result.applied === false);
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.HONEST_LIMITATION);
        assert.strictEqual(result.reason, 'no_candidates');
        assert.strictEqual(result.final_instruction, DEAD_END_FINAL_INSTRUCTION);
    }

    // a throwing discovery router can never break the caller: honest dead end.
    {
        const result = await attemptRecovery({
            question: 'q',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: async () => { throw new Error('adapter down'); },
        });
        assert.ok(result && result.applied === false);
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.HONEST_LIMITATION);
        assert.ok(result.reason.startsWith('discovery_error:'), 'router failures must be attributable, not fatal');
    }

    // recovering a preference keeps the recommendation honest (no objective claim).
    {
        const result = await attemptRecovery({
            question: 'Какое необычное вино купить?',
            retrieval: { found: false, answerable: false, claim_class: 'grounding_required', evidence: [], conflicts: [] },
            discoveryRouter: stubRouter([item(1)]),
        });
        assert.ok(result && result.applied === true);
        assert.strictEqual(result.strategy, RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY);
        assert.strictEqual(result.final_instruction, RECOVERY_FINAL_INSTRUCTIONS[RECOVERY_STRATEGIES.PREFERENCE_DISCOVERY]);
    }

    // ---------------------------------------------------------------- end-to-end (tool) ----
    // The real production path: routeKnowledgeWithAnswerabilityGate via
    // search_wine_knowledge's createImpl. Original query finds nothing; the
    // reframed generic category query discovers a supported canonical fact.
    // The outcome must be status 'recovered', answerable stays false, and the
    // recovered claims carry provenance.
    {
        const calls = [];
        const adapters = {
            searchCanonical: async () => { calls.push('canonical'); return []; },
            searchCatalog: async () => { calls.push('catalog'); return []; },
            searchDocuments: async (query) => {
                calls.push(`documents:${query}`);
                return String(query || '').toLowerCase().includes('молдавск')
                    ? [{
                          level: LEVELS.CANONICAL,
                          title: 'Canonical fact',
                          source: 'docs/canonical.md',
                          confidence: 'high',
                          text: 'Castel Mimi grows the autochthonous Fetească Neagră grape.',
                      }]
                    : [];
            },
            searchInternet: async () => { calls.push('web'); return []; },
        };
        const routeImpl = (query, options) => routeKnowledgeWithAnswerabilityGate(query, {
            ...options,
            adapters,
            answerabilityModel: { apiKey: '' },
        });
        const impl = tool.createImpl(routeImpl);
        const result = await impl({ query: 'Какой виноград у Castel Mimi?' }, { log: () => {} });

        assert.strictEqual(result.found, false, 'retrieval genuinely found nothing');
        assert.strictEqual(result.answerable, false, 'recovery must never flip answerable to true');
        assert.strictEqual(result.status, 'recovered', 'the dead-end not_found path must recover to supported facts');
        assert.strictEqual(result.recovery.applied, true);
        assert.strictEqual(result.recovery.strategy, RECOVERY_STRATEGIES.NEAREST_CONFIRMED_FACT);
        assert.ok(result.claims.length >= 1, 'recovery must supply at least one supported claim');
        assert.ok(result.claims.every((c) => c.kind === 'verified_fact' && c.source && c.source.url),
            'recovered claims must carry provenance from the canonical level');
        const documentCalls = calls.filter((c) => c.startsWith('documents:'));
        assert.strictEqual(documentCalls.length, 2,
            'one retrieval pass on the original query plus one discovery pass on the reframed query');
        assert.ok(documentCalls[1].toLowerCase().includes('молдавск'),
            'the discovery pass must use the reframed generic query');
    }

    console.log('ALL USEFUL ANSWER RECOVERY TESTS PASSED!');
    if (require.main === module) {
        process.exit(0);
    }
}

module.exports = { run, item };

if (require.main === module) {
    run().catch((error) => {
        console.error('Useful answer recovery tests failed:', error);
        process.exit(1);
    });
}
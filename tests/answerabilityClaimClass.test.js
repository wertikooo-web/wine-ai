'use strict';

// Regression suite for the claim-dependent answerability gate.
//
// The gate used to conflate two different questions: "did retrieval find a
// matching document?" (retrieval quality) and "is the model allowed to answer
// this?" (answerability). These tests pin the split:
//   GENERAL_KNOWLEDGE   -> weak/no retrieval must NOT force a refusal
//   GROUNDING_REQUIRED  -> no attributed evidence -> no specific claim
// plus evidence/entity attribution and the multi-turn referent fix.
//
// Everything below runs through the REAL production path
// (routeKnowledgeWithAnswerabilityGate -> searchLayeredKnowledge's impl), with
// only retrieval and the single grader call stubbed, so these are assertions
// about shipping behavior, not about isolated helpers.

const assert = require('assert');
const tool = require('../src/tools/searchLayeredKnowledge');
const {
    LEVELS,
    CLAIM_CLASSES,
    classifyClaimDependency,
    routeKnowledgeWithAnswerabilityGate,
} = require('../src/knowledge/layeredRouter');

const context = { log: () => {} };

// Topically related, never actually answering: the exact shape that produced
// both the false refusals and the wrong-entity attributions in production.
function looseFragment(index, text) {
    return {
        level: LEVELS.DOCUMENTS,
        text: text || `Общая информация о виноделии Молдовы, фрагмент ${index}.`,
        title: `Fragment ${index}`,
        source: `https://example.md/doc-${index}`,
        confidence: 'medium',
        relevance_score: 0.4,
    };
}

function adapters({ documentItems = [], webItems = [] } = {}) {
    const calls = [];
    return {
        calls,
        value: {
            searchCanonical: async () => { calls.push('canonical'); return []; },
            searchCatalog: async () => { calls.push('catalog'); return []; },
            searchDocuments: async (query) => { calls.push(`documents:${query}`); return documentItems; },
            searchInternet: async () => { calls.push('web'); return webItems; },
        },
    };
}

// Wires the live tool to the real gate with a stubbed grader whose JSON is
// exactly what the extended single-call schema now returns.
function toolWithGrader({ documentItems = [], webItems = [], grader = null }) {
    const { value, calls } = adapters({ documentItems, webItems });
    const routeImpl = (query, options) => routeKnowledgeWithAnswerabilityGate(query, {
        ...options,
        adapters: value,
        answerabilityModel: grader
            ? { generateContent: async () => ({ text: JSON.stringify(grader) }) }
            // No grader configured at all -> checkAnswerability returns
            // answerable:null, i.e. the "grader unavailable" path.
            : {},
    });
    return { impl: tool.createImpl(routeImpl), calls };
}

async function run() {
    console.log('Running Claim-Dependent Answerability Gate Tests...');

    // ---------------------------------------------------------------- 1 ----
    // General answerability: weak retrieval + a general wine-knowledge
    // question must NOT produce a forced refusal. This is the core bug: a
    // strong model can safely explain malolactic fermentation with zero risk
    // of inventing an unverifiable specific fact.
    console.log('Testing: weak retrieval + general wine-knowledge question -> answer allowed, not refused...');
    {
        const { impl } = toolWithGrader({
            documentItems: [looseFragment(1), looseFragment(2)],
            grader: {
                answerable: false,
                claim_class: 'general_knowledge',
                evidence_entity_match: 'not_applicable',
                reason: 'evidence does not describe the process',
            },
        });
        const result = await impl({ query: 'Что такое яблочно-молочное брожение в вине?' }, context);

        assert.strictEqual(result.claimClass, CLAIM_CLASSES.GENERAL_KNOWLEDGE);
        assert.strictEqual(result.status, 'general_knowledge', 'must not be reported as insufficient');
        assert.strictEqual(result.answerable, true, 'general knowledge must not be gated on retrieval evidence');
        const instruction = result.answer_policy.final_instruction;
        assert.ok(/Answer it fully and confidently/i.test(instruction),
            'the model must be told to answer, not to decline');
        assert.ok(!/cannot be reliably confirmed/i.test(instruction),
            'a general question must never receive the grounded-refusal instruction');
        // The one hard limit that must survive: no invented specific facts.
        assert.ok(/do not attribute any specific figure, vintage, award, price/i.test(instruction),
            'general answering must still forbid inventing entity-specific specs');
    }

    // Same, but with literally zero evidence retrieved (found:false) -- the
    // not_found branch had the same forced-refusal bug.
    console.log('Testing: ZERO retrieval + general wine-knowledge question -> still answer allowed...');
    {
        const { impl } = toolWithGrader({ documentItems: [], webItems: [] });
        const result = await impl({ query: 'Почему вино декантируют и как это влияет на вкус?' }, context);

        assert.strictEqual(result.found, false, 'retrieval genuinely found nothing');
        assert.strictEqual(result.claimClass, CLAIM_CLASSES.GENERAL_KNOWLEDGE,
            'with no evidence the deterministic classifier must still recognize a general question');
        assert.strictEqual(result.answerable, true, 'empty retrieval must not forbid general education');
        assert.strictEqual(result.status, 'general_knowledge');
    }

    // ---------------------------------------------------------------- 2 ----
    // Specific grounding: weak retrieval + a specific product-fact question
    // must produce an honest decline, and the instruction must be warm
    // sommelier voice, not legalese.
    console.log('Testing: weak retrieval + specific product-fact question -> honest decline, no invented claim...');
    {
        const { impl } = toolWithGrader({
            documentItems: [looseFragment(1), looseFragment(2)],
            grader: {
                answerable: false,
                claim_class: 'grounding_required',
                evidence_entity_match: 'not_applicable',
                reason: 'no ABV anywhere in the evidence',
            },
        });
        const result = await impl({ query: 'Какая крепость у Purcari Negru de Purcari 2019?' }, context);

        assert.strictEqual(result.claimClass, CLAIM_CLASSES.GROUNDING_REQUIRED);
        assert.strictEqual(result.status, 'recovered');
        assert.strictEqual(result.answerable, false, 'an unsupported specific claim must not be permitted');
        assert.strictEqual(result.recovery.strategy, 'entity_alternatives',
            'without a grader "match" verdict the evidence is not attributable to the asked wine -> recover alternatives, never answer unsupported fragments as the confirmed part');
        const instruction = result.answer_policy.final_instruction;
        assert.ok(/The exact producer or wine the user named cannot be confirmed/i.test(instruction),
            'the model must not present the fragments as a confirmed answer');
        assert.ok(/Never state facts about the unconfirmed original/i.test(instruction),
            'the model must be told not to transfer facts from unattributable evidence');
        // Persona guard: the recovery must stay a sommelier, not a compliance
        // notice. Regression pin for the rejected phrasing style
        // ("Недостаточно контекстуальной доказательной информации...").
        assert.ok(/two short natural sentences/i.test(instruction),
            'recovery must stay spoken-word short, not an essay');
        assert.ok(!/Answer directly and confidently/i.test(instruction),
            'recovery must never present the loosely-related fragments as a confident full answer');
    }

    // ---------------------------------------------------------------- 3 ----
    // Wrong-entity evidence: the ~22% unsupported-claim failure mode. Evidence
    // genuinely about Entity B must never be used to answer about Entity A.
    console.log('Testing: question about Entity A but evidence is about Entity B -> fact not attributed to A...');
    {
        const { impl } = toolWithGrader({
            documentItems: [
                looseFragment(1, 'Винодельня Castel Mimi: главный винодел — Иван Иванов, хозяйство основано в 1893 году.'),
                looseFragment(2, 'Castel Mimi располагает собственными виноградниками.'),
            ],
            // Grader says the evidence LOOKS answerable but concerns another
            // producer -- precisely the batch-contamination case.
            grader: {
                answerable: true,
                claim_class: 'grounding_required',
                evidence_entity_match: 'mismatch',
                reason: 'fragments describe Castel Mimi, not the winery asked about',
            },
        });
        const result = await impl({ query: 'Кто главный винодел на винодельне Asconi?' }, context);

        assert.strictEqual(result.entityMatch, 'mismatch');
        assert.strictEqual(result.answerable, false,
            'evidence about a different producer must not make the claim answerable');
        assert.strictEqual(result.status, 'recovered', 'a mismatch must recover to confirmed alternatives, not reuse the wrong producer\'s evidence');
        assert.strictEqual(result.recovery.strategy, 'entity_alternatives');
        const instruction = result.answer_policy.final_instruction;
        assert.ok(/Never state facts about the unconfirmed original/i.test(instruction),
            'the recovered alternatives must never attach facts to the unconfirmed winery');
        assert.ok(/DIFFERENT producer or wine than the one asked about/i.test(instruction),
            'the model must be warned about the entity mismatch explicitly');
        assert.ok(/Never transfer a fact from one producer or bottling to another/i.test(instruction),
            'the model must be forbidden from re-attributing the fact');
    }

    // ---------------------------------------------------------------- 4 ----
    // Multi-turn referent: a bare follow-up ("а какое из них легче?") carries
    // no entity. The realtime session already keeps recentTurns; the tool must
    // reuse it to enrich the RETRIEVAL query while leaving the user's own
    // wording intact.
    console.log('Testing: referent-dependent follow-up is enriched from recentTurns before retrieval...');
    {
        const { impl, calls } = toolWithGrader({
            documentItems: [looseFragment(1)],
            grader: {
                answerable: true, claim_class: 'grounding_required',
                evidence_entity_match: 'match', reason: 'ok',
            },
        });
        const multiTurnContext = {
            log: () => {},
            recentTurns: [
                { role: 'user', text: 'Расскажи про Fetească Neagră и Rara Neagră' },
                { role: 'assistant', text: 'Это два молдавских автохтонных сорта...' },
            ],
        };
        const result = await impl({ query: 'А какое из них легче?' }, multiTurnContext);

        const documentCall = calls.find((c) => c.startsWith('documents:'));
        assert.ok(documentCall.includes('Fetească Neagră'),
            'the prior turn entities must reach retrieval, not just the bare pronoun');
        assert.ok(documentCall.includes('А какое из них легче?'),
            'the user\'s own wording must be preserved in the retrieval query');
        assert.strictEqual(result.found, true);

        // And the inverse: a self-contained question must NOT be polluted with
        // unrelated prior turns.
        const { impl: impl2, calls: calls2 } = toolWithGrader({
            documentItems: [looseFragment(1)],
            grader: {
                answerable: true, claim_class: 'grounding_required',
                evidence_entity_match: 'match', reason: 'ok',
            },
        });
        await impl2({ query: 'Сколько стоит бутылка Cricova Brut?' }, multiTurnContext);
        const documentCall2 = calls2.find((c) => c.startsWith('documents:'));
        assert.ok(!documentCall2.includes('Fetească Neagră'),
            'a self-contained question must not be enriched with unrelated history');

        // No session history reaching the tool at all must be a safe no-op.
        const { impl: impl3, calls: calls3 } = toolWithGrader({
            documentItems: [looseFragment(1)],
            grader: {
                answerable: true, claim_class: 'grounding_required',
                evidence_entity_match: 'match', reason: 'ok',
            },
        });
        await impl3({ query: 'А какое из них легче?' }, { log: () => {} });
        assert.ok(calls3.find((c) => c === 'documents:А какое из них легче?'),
            'without recentTurns the query must pass through unchanged');
    }

    // ---------------------------------------------------------------- 5 ----
    // The good path must be untouched: genuinely covering evidence still
    // yields a confident specific answer with no refusal and no mismatch note.
    console.log('Testing: good evidence -> confident specific answer path still works unchanged...');
    {
        const { impl, calls } = toolWithGrader({
            // Strong relevance on purpose: this is the "retrieval genuinely
            // worked" path, so routeKnowledge's own weak-internal web fallback
            // (documentThreshold 0.45) must not fire either.
            documentItems: [{
                ...looseFragment(1, 'Purcari Negru de Purcari 2019: крепость 14%, выдержка 12 месяцев в дубе.'),
                relevance_score: 0.85,
                confidence: 'high',
            }],
            grader: {
                answerable: true,
                claim_class: 'grounding_required',
                evidence_entity_match: 'match',
                reason: 'ABV explicitly stated for the asked wine',
            },
        });
        const result = await impl({ query: 'Какая крепость у Purcari Negru de Purcari 2019?' }, context);

        assert.strictEqual(result.found, true);
        assert.strictEqual(result.answerable, true);
        assert.strictEqual(result.status, 'found');
        assert.strictEqual(result.entityMatch, 'match');
        assert.ok(!calls.includes('web'), 'a confirmed answer must not trigger a web fallback');
        const instruction = result.answer_policy.final_instruction;
        assert.ok(/Answer directly and confidently from the evidence/i.test(instruction));
        assert.ok(!/DIFFERENT producer/i.test(instruction),
            'a matching-entity answer must not carry the mismatch warning');
    }

    // ---------------------------------------------------------------- 6 ----
    // Skeptical review of the fix itself: the new permission must never widen
    // when the grader is silent, and must never open for unknown/fictional or
    // similarly-named entities. These are the cases where "general knowledge"
    // would become a NEW hallucination channel.
    console.log('Testing: deterministic fallback never opens general answering for entity-specific claims...');
    {
        const groundingRequired = [
            'Какая крепость у Purcari Negru de Purcari?',        // specific attribute
            'Сколько стоит Cricova Brut?',                        // known entity + price
            'Кто винодел на винодельне Château Imaginaire?',      // fictional entity
            'Расскажи о винодельне Purcari Premium Reserve',      // similarly-named
            'В каком году основана винодельня «Виноградная долина»?', // quoted unknown entity
            'What awards did Castel Mimi win?',                   // English, known entity
            'Ce preț are vinul de la Asconi?',                    // Romanian, known entity
            'Какая выдержка у этого вина?',                       // attribute, no entity named
        ];
        for (const query of groundingRequired) {
            assert.strictEqual(
                classifyClaimDependency(query), CLAIM_CLASSES.GROUNDING_REQUIRED,
                `must stay grounding_required: ${query}`
            );
        }

        const generalKnowledge = [
            'Что такое яблочно-молочное брожение в вине?',
            'Чем отличается Каберне Совиньон от Мерло на вкус вина?',
            'Почему вино декантируют и как это меняет вкус?',
            'What is the difference between tannins in red and white wine?',
            'De ce se decantează vinul roșu?',
        ];
        for (const query of generalKnowledge) {
            assert.strictEqual(
                classifyClaimDependency(query), CLAIM_CLASSES.GENERAL_KNOWLEDGE,
                `must be general_knowledge: ${query}`
            );
        }
    }

    console.log('Testing: registry-backed entity signal (resolveEntity, not a hardcoded name array)...');
    {
        // A. KNOWN ENTITY -- names that exist ONLY in the expanded Ghid registry,
        // never in the old 14-name KNOWN_WINERY_NAMES array. These prove the
        // resolver is really wired in; they would all fall through before.
        for (const query of [
            'Расскажи про винодельню Timbrus',
            'Что производит Chateau Vartely Individo',
            'Vinaria din Vale ce vinuri face?',
            'Расскажи о Château Cristi',
        ]) {
            assert.strictEqual(
                classifyClaimDependency(query), CLAIM_CLASSES.GROUNDING_REQUIRED,
                `registry entity must be grounding_required: ${query}`
            );
        }

        // C. UNKNOWN PROPER ENTITY -- the safety-critical case this sprint exists
        // for. resolveEntity() returning found:false must NOT be read as "general
        // knowledge is safe"; a proper-noun-shaped query about a producer the
        // registry does not know is exactly where unhedged answering fabricates.
        const unknownEntity = require('../src/knowledge/entityResolver').resolveEntity('Lion Gri');
        assert.strictEqual(unknownEntity.found, false,
            'precondition: "Lion Gri" must be absent from the registry for this test to mean anything');
        for (const query of [
            'Расскажи про Lion Gri',                    // unknown, two-token
            'Что такое вино Lioness и почему оно такое?', // unknown, single token + explanation shape
            'Почему вино от Timbrusa такое танинное?',   // near-miss unknown spelling
        ]) {
            assert.strictEqual(
                classifyClaimDependency(query), CLAIM_CLASSES.GROUNDING_REQUIRED,
                `unknown proper entity must NOT be treated as safe general knowledge: ${query}`
            );
        }

        // Preserved from the entity-registry benchmark: these must not regress.
        assert.strictEqual(
            require('../src/knowledge/entityResolver').resolveEntity('dacă vinul e sec').found, false,
            '"dacă" must not match the DAC entity (word-boundary fix)'
        );
        // Grape varieties are education, never producer claims.
        for (const query of [
            'Чем отличается Каберне Совиньон от Мерло на вкус вина?',
            'Что такое Fetească Neagră как сорт винограда?',
        ]) {
            assert.strictEqual(
                classifyClaimDependency(query), CLAIM_CLASSES.GENERAL_KNOWLEDGE,
                `grape-variety question must stay general_knowledge: ${query}`
            );
        }

        // A resolver fault must fail conservative, not fail open.
        const boom = () => { throw new Error('registry unreadable'); };
        assert.strictEqual(
            classifyClaimDependency('Расскажи про Lion Gri', { resolveEntityFn: boom }),
            CLAIM_CLASSES.GROUNDING_REQUIRED,
            'resolver failure must not unlock general answering'
        );
    }

    console.log('Testing: grader unavailable must not upgrade an entity-specific question to general...');
    {
        // No grader configured -> answerable:null, claimClass:null -> the
        // deterministic classifier decides, and it must stay conservative.
        const { impl } = toolWithGrader({ documentItems: [looseFragment(1)], webItems: [] });
        const result = await impl({ query: 'Какая крепость у Purcari Negru de Purcari 2019?' }, context);

        assert.strictEqual(result.claimClass, CLAIM_CLASSES.GROUNDING_REQUIRED);
        assert.notStrictEqual(result.status, 'general_knowledge',
            'a silent grader must never unlock free-form answering for a product-fact question');
        assert.notStrictEqual(result.answerable, true, 'a silent grader must never make a specific claim confidently answerable');
        assert.strictEqual(result.recovery.strategy, 'entity_alternatives',
            'with no "match" verdict the retrieved evidence is not attributable -> recover confirmed alternatives, never answer unattributable fragments as the confirmed part');
        assert.ok(/The exact producer or wine the user named cannot be confirmed/i.test(result.answer_policy.final_instruction));
    }

    console.log('ALL CLAIM-DEPENDENT ANSWERABILITY GATE TESTS PASSED!');
}

run().catch((error) => {
    console.error('Claim-dependent answerability gate tests failed:', error);
    process.exit(1);
});

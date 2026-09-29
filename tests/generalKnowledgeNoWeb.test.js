'use strict';

// General wine knowledge is answered from the knowledge base and the model's
// own knowledge, never from a slow web round-trip (4-8 s of silence in
// voice). Web stays for grounding-required claims the base cannot confirm,
// freshness questions and explicit force_web. WEB_FOR_GENERAL_KNOWLEDGE=true
// restores the old behavior.

const t = require('./helpers/assertions');
const tool = require('../src/tools/searchLayeredKnowledge');
const { LEVELS, routeKnowledgeWithAnswerabilityGate } = require('../src/knowledge/layeredRouter');

const loose = (i) => ({ level: LEVELS.DOCUMENTS, text: `Общая информация о винах, фрагмент ${i}.`, title: `F${i}`, source: `kos://doc-${i}`, confidence: 'medium', relevance_score: 0.3 });
const webItem = { level: LEVELS.WEB, text: 'Web fact', title: 'web', source: 'https://example.org', confidence: 'medium', relevance_score: 0.9 };

function setup({ grader, documentItems = [loose(1), loose(2)] }) {
    const calls = [];
    const adapters = {
        searchCanonical: async () => [],
        searchRelations: async () => [],
        searchCatalog: async () => [],
        searchDocuments: async () => documentItems,
        searchInternet: async () => { calls.push('web'); return [webItem]; },
    };
    const routeImpl = (query, options) => routeKnowledgeWithAnswerabilityGate(query, {
        ...options,
        adapters,
        answerabilityModel: { generateContent: async () => ({ text: JSON.stringify(grader) }) },
    });
    return { impl: tool.createImpl(routeImpl), calls };
}

const GENERAL = { answerable: false, claim_class: 'general_knowledge', evidence_entity_match: 'not_applicable', reason: 'loose fragments' };
const GROUNDED = { answerable: false, claim_class: 'grounding_required', evidence_entity_match: 'match', reason: 'fact not in evidence' };
const ctx = { log: () => {}, isWebSearchEnabled: () => true };

async function run() {
    const saved = process.env.WEB_FOR_GENERAL_KNOWLEDGE;
    delete process.env.WEB_FOR_GENERAL_KNOWLEDGE;
    try {
        {
            const { impl, calls } = setup({ grader: GENERAL });
            const out = await impl({ query: 'Что такое зелёное вино vinho verde и чем оно отличается?' }, ctx);
            t.equal(calls.length, 0, 'general wine question: no web call');
            t.equal(out.status, 'general_knowledge', 'answered from the model\'s knowledge');
            t.equal(out.answerable, true, 'not refused');
        }
        {
            const { impl, calls } = setup({ grader: GENERAL, documentItems: [] });
            await impl({ query: 'Почему вино декантируют?' }, ctx);
            t.equal(calls.length, 0, 'general wine question with an empty base: still no web call');
        }
        {
            const { impl, calls } = setup({ grader: GROUNDED });
            await impl({ query: 'Сколько гектаров виноградников у Castel Mimi?' }, ctx);
            t.ok(calls.length >= 1, 'grounding-required fact the base cannot confirm: web is still used');
        }
        {
            const { impl, calls } = setup({ grader: GENERAL });
            await impl({ query: 'Что такое зелёное вино?', force_web: true }, ctx);
            t.ok(calls.length >= 1, 'explicit force_web still goes to the web');
        }
        {
            process.env.WEB_FOR_GENERAL_KNOWLEDGE = 'true';
            const { impl, calls } = setup({ grader: GENERAL });
            await impl({ query: 'Что такое зелёное вино vinho verde?' }, ctx);
            t.ok(calls.length >= 1, 'WEB_FOR_GENERAL_KNOWLEDGE=true restores web for general questions');
        }
    } finally {
        if (saved === undefined) delete process.env.WEB_FOR_GENERAL_KNOWLEDGE; else process.env.WEB_FOR_GENERAL_KNOWLEDGE = saved;
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('generalKnowledgeNoWeb tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

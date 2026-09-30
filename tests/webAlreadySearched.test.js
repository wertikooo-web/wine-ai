'use strict';

// Production 30 Sep: search_wine_knowledge already returned web sources for
// "Какие новости у винодельни Purcari...", then the model called search_web
// for the same question (+5.2s before the answer). A result that already
// used the web tells the model not to search the web again.

const t = require('./helpers/assertions');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');
const { bindTool } = require('../src/tools/toolHelpers');

async function run() {
    const routedWith = (webUsed) => async () => ({
        found: true,
        evidence: [{ title: 'Purcari', text: 'Purcari Wineries news.', level: webUsed ? 'web' : 'documents' }],
        used_levels: webUsed ? ['documents', 'web'] : ['documents'], web_used: webUsed, answerable: true, conflicts: [],
        answer_policy: { final_instruction: 'Answer from the evidence.' },
    });
    const ctx = { isWebSearchEnabled: () => true };

    const withWeb = await createImpl(routedWith(true))({ query: 'новости Purcari' }, ctx);
    const i1 = withWeb.answer_policy.final_instruction;
    t.ok(/do not call search_web for it again/.test(i1), 'web already used: model told not to call search_web again');
    t.ok(/Answer in the language the user is speaking/.test(i1), 'reply-language rule still appended');

    const noWeb = await createImpl(routedWith(false))({ query: 'Где находится Purcari?' }, ctx);
    t.ok(!/search_web/.test(noWeb.answer_policy.final_instruction), 'no web used: search_web stays available');

    // Server gate (the instruction alone did not stop the model in
    // production): within one generation, search_web after a web-backed
    // knowledge result returns those sources at once, no internet call.
    let webCalls = 0;
    const toolContext = { isWebSearchEnabled: () => true };
    const knowledge = bindTool({ name: 'search_wine_knowledge', impl: async () => ({ found: true, webUsed: true, webSources: [{ title: 'Purcari news', url: 'https://purcari.wine/news' }] }) }, toolContext);
    const searchWeb = bindTool({ name: 'search_web', impl: async () => { webCalls += 1; return { found: true, results: [] }; } }, toolContext);
    await knowledge({ args: { query: 'новости Purcari' }, generationId: 'g1' });
    const deduped = await searchWeb({ args: { query: 'Purcari news' }, generationId: 'g1' });
    t.equal(webCalls, 0, 'same generation: no second internet search');
    t.equal(deduped.results[0].url, 'https://purcari.wine/news', 'same generation: the already-found sources are returned');
    t.ok(/Do not search again/.test(deduped.instruction), 'same generation: told to answer now');
    await searchWeb({ args: { query: 'Purcari news' }, generationId: 'g2' });
    t.equal(webCalls, 1, 'next generation: search_web works normally');

    const knowledgeNoWeb = bindTool({ name: 'search_wine_knowledge', impl: async () => ({ found: true, webUsed: false, webSources: [] }) }, toolContext);
    await knowledgeNoWeb({ args: { query: 'Где Purcari?' }, generationId: 'g3' });
    await searchWeb({ args: { query: 'Purcari' }, generationId: 'g3' });
    t.equal(webCalls, 2, 'knowledge without web: search_web still searches');
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('webAlreadySearched tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

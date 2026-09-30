'use strict';

// Production 30 Sep: search_wine_knowledge already returned web sources for
// "Какие новости у винодельни Purcari...", then the model called search_web
// for the same question (+5.2s before the answer). A result that already
// used the web tells the model not to search the web again.

const t = require('./helpers/assertions');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');

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
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('webAlreadySearched tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

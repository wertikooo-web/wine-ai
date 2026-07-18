'use strict';

const { buildIndex } = require('../src/knowledge/index');
const { search } = require('../src/knowledge/search');

const CASES = [
    { query: 'Расскажи, чем Фетяска Нягрэ отличается от Каберне Совиньон.', language: 'ru', expectTitle: /Фетяска/ },
    { query: 'Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.', language: 'ro', expectTitle: /Fetească/ },
    { query: 'Which Moldovan wine would you recommend with roast lamb?', language: 'en', expectTitle: /lamb/i },
];

function main() {
    const built = buildIndex();
    console.log(`ok   knowledge:index — documents=${built.documentCount} chunks=${built.chunkCount}`);
    if (built.errors.length > 0) {
        console.warn(`warn ${built.errors.length} document error(s) during indexing`);
    }

    let failed = 0;
    for (const { query, language, expectTitle } of CASES) {
        const { hits } = search(query, { language, limit: 1 });
        const top = hits[0];
        const pass = Boolean(top) && expectTitle.test(top.chunk.metadata.title);
        console.log(`${pass ? 'ok  ' : 'FAIL'} "${query.slice(0, 50)}..." -> ${top ? top.chunk.metadata.title : '(no hit)'}`);
        if (!pass) failed += 1;
    }

    console.log(failed === 0 ? '\nknowledge-smoke passed' : `\nknowledge-smoke FAILED (${failed} case(s))`);
    process.exit(failed === 0 ? 0 : 1);
}

main();

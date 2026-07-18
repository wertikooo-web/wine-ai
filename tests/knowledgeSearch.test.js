'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { search } = require('../src/knowledge/search');
const { buildIndex } = require('../src/knowledge/index');
const t = require('./helpers/assertions');

async function run() {
    // Uses the real, checked-in knowledge/source docs and the index built by
    // `npm run knowledge:index` — run that first if this is a clean checkout
    // (see AGENTS.md's required verification list).
    const ru = search('Расскажи, чем Фетяска Нягрэ отличается от Каберне Совиньон.', { language: 'ru', limit: 2 });
    t.ok(ru.hits.length > 0, 'expected at least one hit for the Fetească Neagră vs Cabernet Sauvignon question');
    t.match(ru.hits[0].chunk.metadata.title, /Фетяска/, 'top hit should be the Fetească Neagră profile');

    const ro = search('Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.', { language: 'ro', limit: 2 });
    t.ok(ro.hits.length > 0, 'expected at least one hit for the Romanian Fetească Neagră question');
    t.equal(ro.hits[0].chunk.metadata.language, 'ro');

    const en = search('Which Moldovan wine would you recommend with roast lamb?', { language: 'en', limit: 2 });
    t.ok(en.hits.length > 0, 'expected at least one hit for the roast lamb pairing question');
    t.match(en.hits[0].chunk.metadata.title, /lamb/i);

    // Empty query never throws, returns no hits.
    const emptyQuery = search('', {});
    t.deepEqual(emptyQuery.hits, [], 'an empty query must return no hits, not throw');

    // Empty knowledge base (Stage 13's "тест пустой базы знаний"): point
    // search at a freshly built index over an empty source directory.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-ai-empty-kb-'));
    const emptySourceDir = path.join(tmpDir, 'source');
    const emptyIndexFile = path.join(tmpDir, 'index.json');
    fs.mkdirSync(emptySourceDir, { recursive: true });
    const built = buildIndex({ sourceDir: emptySourceDir, indexFile: emptyIndexFile });
    t.equal(built.chunkCount, 0, 'an empty source dir must build an empty (not failing) index');
    const emptyKbResult = search('Fetească Neagră', { indexFile: emptyIndexFile });
    t.deepEqual(emptyKbResult.hits, [], 'searching an empty knowledge base must return no hits, not throw');
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { run };

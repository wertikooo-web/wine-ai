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
    const ru = await search('Расскажи про сорт винограда Фетяска Нягрэ.', { language: 'ru', limit: 2 });
    t.ok(ru.hits.length > 0, 'expected at least one hit for the Fetească Neagră vs Cabernet Sauvignon question');
    t.match(ru.hits[0].chunk.metadata.title, /Фетяска/, 'top hit should be the Fetească Neagră profile');

    const ro = await search('Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.', { language: 'ro', limit: 2 });
    t.ok(ro.hits.length > 0, 'expected at least one hit for the Romanian Fetească Neagră question');
    t.equal(ro.hits[0].chunk.metadata.language, 'ro');

    const en = await search('Which Moldovan wine would you recommend with roast lamb?', { language: 'en', limit: 2 });
    t.ok(en.hits.length > 0, 'expected at least one hit for the roast lamb pairing question');
    t.match(en.hits[0].chunk.metadata.title, /lamb/i);

    // Narine Abgaryan event retrieval test (ru)
    const narine = await search('Когда встреча с Наринэ Абгарян?', { language: 'ru', limit: 2 });
    t.ok(narine.hits.length > 0, 'expected at least one hit for the Narine Abgaryan event');
    t.match(narine.hits[0].chunk.metadata.title, /Наринэ/, 'top hit should be the Narine Abgaryan event profile');

    // Danila Kozlovsky event retrieval test (ru) - person or event
    const kozlovsky = await search('Музыкальный спектакль CHECK-UP с Данилой Козловским', { language: 'ru', limit: 2 });
    t.ok(kozlovsky.hits.length > 0, 'expected at least one hit for the Danila Kozlovsky event');
    t.match(kozlovsky.hits[0].chunk.metadata.title, /Kozlovsky/, 'top hit should be the Danila Kozlovsky event profile');

    // ONVV organization retrieval test (en) - organization or place
    const onvv = await search('National Office of Vine and Wine', { language: 'en', limit: 2 });
    t.ok(onvv.hits.length > 0, 'expected at least one hit for ONVV');
    t.match(onvv.hits[0].chunk.metadata.title, /ONVV/, 'top hit should be the ONVV profile');

    // Spiegelau glassware retrieval test (ru) - unexpected item or topic
    const spiegelau = await search('хрустальные бокалы Spiegelau', { language: 'ru', limit: 2 });
    t.ok(spiegelau.hits.length > 0, 'expected at least one hit for Spiegelau');
    t.match(spiegelau.hits[0].chunk.metadata.title, /Spiegelau/, 'top hit should be the Spiegelau profile');

    // Empty query never throws, returns no hits.
    const emptyQuery = await search('', {});
    t.deepEqual(emptyQuery.hits, [], 'an empty query must return no hits, not throw');

    // Empty knowledge base (Stage 13's "тест пустой базы знаний"): point
    // search at a freshly built index over an empty source directory.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-ai-empty-kb-'));
    const emptySourceDir = path.join(tmpDir, 'source');
    const emptyIndexFile = path.join(tmpDir, 'index.json');
    fs.mkdirSync(emptySourceDir, { recursive: true });
    const built = buildIndex({ sourceDir: emptySourceDir, indexFile: emptyIndexFile });
    t.equal(built.chunkCount, 0, 'an empty source dir must build an empty (not failing) index');
    const emptyKbResult = await search('Fetească Neagră', { indexFile: emptyIndexFile });
    t.deepEqual(emptyKbResult.hits, [], 'searching an empty knowledge base must return no hits, not throw');
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

module.exports = { run };

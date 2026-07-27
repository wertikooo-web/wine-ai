'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { search, getLastSemanticError } = require('../src/knowledge/search');
const { buildIndex } = require('../src/knowledge/index');
const t = require('./helpers/assertions');

async function run() {
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

    // Entity-aware search: Wine & D should resolve to wine-md entity.
    const wineMD = await search('Wine & D', { limit: 2 });
    t.ok(wineMD.hits.length > 0, 'expected at least one hit for Wine & D');
    if (wineMD.mode === 'entity') {
        t.ok(wineMD.entityResolved.found, 'Wine & D should resolve via entity layer');
        t.equal(wineMD.entityResolved.entityId, 'wine-md', 'Wine & D should resolve to wine-md');
    }

    const wineMdVariant = await search('wine.md', { limit: 2 });
    t.ok(wineMdVariant.hits.length > 0, 'expected at least one hit for wine.md');

    const wineMDVariant2 = await search('WineMD', { limit: 2 });
    t.ok(wineMDVariant2.hits.length > 0, 'expected at least one hit for WineMD');

    const wineMDRu = await search('ВайнМД', { limit: 2 });
    t.ok(wineMDRu.hits.length > 0, 'expected at least one hit for ВайнМД');

    // Diagnostics object must be present in search result
    const withDiag = await search('Fetească Neagră', { limit: 1 });
    t.ok(withDiag.diagnostics !== undefined, 'search result must contain diagnostics');
    t.ok(typeof withDiag.diagnostics.requestedMode === 'string', 'diagnostics must have requestedMode');
    t.ok(typeof withDiag.diagnostics.actualMode === 'string', 'diagnostics must have actualMode');
    t.ok(typeof withDiag.diagnostics.entityMatch === 'boolean', 'diagnostics must have entityMatch');

    // All returned chunks must have enabled !== false.
    const allHits = await search('Moldova', { limit: 10 });
    for (const hit of allHits.hits) {
        t.ok(hit.chunk.metadata.enabled !== false, 'all returned chunks must have enabled !== false');
    }

    // getLastSemanticError must be a function
    t.ok(typeof getLastSemanticError === 'function', 'getLastSemanticError must be exported');

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
    t.ok(emptyKbResult.diagnostics !== undefined, 'empty KB result must have diagnostics');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Language boost: more relevant doc in other language should still rank above
    // weak doc in user's language. Query "roast lamb" with language='ro' — the EN
    // lamb article has high raw relevance (many matching tokens), so even at 0.8x it
    // should beat a Romanian doc that barely matches.
    const langBoostRelevance = await search('Moldovan roast lamb pairing recommendation', { language: 'ro', limit: 5 });
    if (langBoostRelevance.hits.length > 0) {
        const topTitle = langBoostRelevance.hits[0].chunk.metadata.title;
        t.match(topTitle, /lamb/i, 'top hit for "roast lamb" with language=ro should be the lamb article');
    }

    // Entity address ranking: entity resolved, address chunk should rank top-1 for
    // address query about that entity. Uses a controlled index so ranking is predictable.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-ai-entity-address-'));
    const entityIndexFile = path.join(tmpDir2, 'index.json');
    const entityChunks = [
        { id: 'addr-1', text: 'Wine.MD is located at str. Mitropolit Varlaam 65, Chișinău, Moldova', metadata: { title: 'Wine.MD Location and Contacts', entity_id: 'wine-md', source: 'test', source_file: 'test.md' } },
        { id: 'addr-2', text: 'Wine.MD online store offers delivery across Moldova and Romania', metadata: { title: 'Wine.MD Delivery Information', entity_id: 'wine-md', source: 'test', source_file: 'test.md' } },
        { id: 'addr-3', text: 'Wine.MD was founded in 2020 as a wine marketplace', metadata: { title: 'Wine.MD History', entity_id: 'wine-md', source: 'test', source_file: 'test.md' } },
        { id: 'addr-4', text: 'Contact Wine.MD by phone at +373-XX-XXX-XXX', metadata: { title: 'Wine.MD Contact', entity_id: 'wine-md', source: 'test', source_file: 'test.md' } },
    ];
    const entityIdx = {
        built_at: new Date().toISOString(),
        document_count: 1,
        chunk_count: entityChunks.length,
        chunks: entityChunks,
    };
    fs.writeFileSync(entityIndexFile, JSON.stringify(entityIdx, null, 2));
    const addressQuery = await search('Where is Wine.MD located? Find address', { limit: 3, indexFile: entityIndexFile });
    t.ok(addressQuery.hits.length > 0, 'address query should return hits');
    if (addressQuery.mode === 'entity' || addressQuery.entityResolved) {
        t.equal(addressQuery.hits[0].chunk.id, 'addr-1', 'address query top-1 should be the Location chunk (addr-1)');
    }
    fs.rmSync(tmpDir2, { recursive: true, force: true });

    // Entity enabled=false: all entity chunks are disabled -> empty result.
    const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-ai-disabled-entity-'));
    const disabledIndexFile = path.join(tmpDir3, 'index.json');
    const disabledChunks = [
        {
            id: 'disabled-md-1',
            text: 'Wine.MD platform address: str. Test 123, Chișinău',
            metadata: { title: 'Wine.MD Contact', entity_id: 'wine-md', enabled: false, source: 'test', source_file: 'test.md' },
        },
        {
            id: 'disabled-md-2',
            text: 'Wine.MD offering various Moldovan wines for sale',
            metadata: { title: 'Wine.MD Products', entity_id: 'wine-md', enabled: false, source: 'test', source_file: 'test.md' },
        },
    ];
    const disabledIndex = {
        built_at: new Date().toISOString(),
        document_count: 1,
        chunk_count: 2,
        chunks: disabledChunks,
    };
    fs.writeFileSync(disabledIndexFile, JSON.stringify(disabledIndex, null, 2));
    const entityWithDisabled = await search('Wine & D адрес', { limit: 5, indexFile: disabledIndexFile });
    t.equal(entityWithDisabled.hits.length, 0, 'entity search must return 0 hits when all entity chunks are disabled');
    fs.rmSync(tmpDir3, { recursive: true, force: true });
}

module.exports = { run };

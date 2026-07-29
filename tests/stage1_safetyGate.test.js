'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { bindTool, setSearchBlock } = require('../src/tools/toolHelpers');

describe('Stage 1 safety gate — external tool blocking', () => {
    let toolContext;
    let searchWineKnowledgeFound;
    let searchWineKnowledge;
    let searchWeb;
    let searchPlace;
    let fetchPage;

    before(() => {
        toolContext = { log: () => {} };

        searchWineKnowledge = bindTool({
            name: 'search_wine_knowledge',
            impl: async (args, ctx) => {
                setSearchBlock(ctx, searchWineKnowledgeFound ? 'found' : 'not_found');
                return searchWineKnowledgeFound
                    ? { found: true, status: 'found', results: [{ title: 'test', score: 0.9 }] }
                    : { found: false, status: 'not_found', results: [] };
            },
        }, toolContext);

        searchWeb = bindTool({
            name: 'search_web',
            impl: async () => ({ found: true, results: [{ title: 'web result' }] }),
        }, toolContext);

        searchPlace = bindTool({
            name: 'search_place',
            impl: async () => ({ found: true, places: [{ name: 'place' }] }),
        }, toolContext);

        fetchPage = bindTool({
            name: 'fetch_page',
            impl: async () => ({ found: true, title: 'page' }),
        }, toolContext);
    });

    it('blocks search_web after search_wine_knowledge NOT_FOUND (same generation)', async () => {
        searchWineKnowledgeFound = false;
        const genId = 'gen-1';

        const knowledgeResult = await searchWineKnowledge({ args: { query: 'unknown entity' }, generationId: genId });
        assert.equal(knowledgeResult.status, 'not_found');

        const webResult = await searchWeb({ args: { query: 'unknown entity' }, generationId: genId });
        assert.equal(webResult.error, 'external_search_blocked');
    });

    it('blocks search_place after search_wine_knowledge NOT_FOUND', async () => {
        searchWineKnowledgeFound = false;
        const genId = 'gen-2';

        await searchWineKnowledge({ args: { query: 'unknown entity' }, generationId: genId });
        const result = await searchPlace({ args: { entity_name: 'unknown' }, generationId: genId });
        assert.equal(result.error, 'external_search_blocked');
    });

    it('blocks fetch_page after search_wine_knowledge NOT_FOUND', async () => {
        searchWineKnowledgeFound = false;
        const genId = 'gen-3';

        await searchWineKnowledge({ args: { query: 'unknown entity' }, generationId: genId });
        const result = await fetchPage({ args: { url: 'https://example.com' }, generationId: genId });
        assert.equal(result.error, 'external_search_blocked');
    });

    it('does NOT block external tools when search_wine_knowledge found results', async () => {
        searchWineKnowledgeFound = true;
        const genId = 'gen-4';

        const knowledgeResult = await searchWineKnowledge({ args: { query: 'Purcari' }, generationId: genId });
        assert.equal(knowledgeResult.status, 'found');

        const webResult = await searchWeb({ args: { query: 'Purcari' }, generationId: genId });
        assert.equal(webResult.error, undefined);
        assert.ok(webResult.found);
    });

    it('allows external tools when search_wine_knowledge was never called', async () => {
        const genId = 'gen-5';

        const result = await searchWeb({ args: { query: 'anything' }, generationId: genId });
        assert.notEqual(result.error, 'external_search_blocked');
    });

    it('NOT_FOUND → FOUND in same generation does NOT unblock external tools', async () => {
        const genId = 'gen-6';

        searchWineKnowledgeFound = false;
        await searchWineKnowledge({ args: { query: 'unknown' }, generationId: genId });
        assert.equal((await searchWeb({ args: { query: 'x' }, generationId: genId })).error, 'external_search_blocked');

        searchWineKnowledgeFound = true;
        await searchWineKnowledge({ args: { query: 'Purcari' }, generationId: genId });

        const stillBlocked = await searchWeb({ args: { query: 'Purcari' }, generationId: genId });
        assert.equal(stillBlocked.error, 'external_search_blocked');
    });

    it('does not carry block across different generationIds', async () => {
        searchWineKnowledgeFound = false;
        const genA = 'gen-a';
        const genB = 'gen-b';

        await searchWineKnowledge({ args: { query: 'unknown' }, generationId: genA });

        const resultB = await searchWeb({ args: { query: 'anything' }, generationId: genB });
        assert.notEqual(resultB.error, 'external_search_blocked');
        assert.ok(resultB.found);
    });

    it('logs tool_blocked event when external tool is blocked', async () => {
        const logs = [];
        const ctx = { log: (stage, extra) => logs.push({ stage, extra }) };

        const localKnowledge = bindTool({
            name: 'search_wine_knowledge',
            impl: async (args, c) => {
                setSearchBlock(c, 'not_found');
                return { found: false, status: 'not_found', results: [] };
            },
        }, ctx);

        const localWeb = bindTool({
            name: 'search_web',
            impl: async () => ({ found: true }),
        }, ctx);

        const genId = 'gen-log';
        await localKnowledge({ args: { query: 'x' }, generationId: genId });
        await localWeb({ args: { query: 'x' }, generationId: genId });

        const blockEvent = logs.find((l) => l.stage === 'tool_blocked');
        assert.ok(blockEvent);
        assert.equal(blockEvent.extra.tool, 'search_web');
        assert.equal(blockEvent.extra.reason, 'entity_not_found');
        assert.equal(blockEvent.extra.generationId, genId);
    });
});

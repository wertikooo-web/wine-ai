'use strict';

// Dashboard "knowledge base only" switch (cost_settings.web_search_enabled):
// when off, search_wine_knowledge never consults the web level and the
// internet tools (search_web, fetch_page) are refused; search_place stays.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'memory';

const t = require('./helpers/assertions');
const { sanitizeSettingsPatch, createMemoryCostStore, setCostStoreForTests } = require('../src/cost/costStore');
const { createCostApi } = require('../src/cost/costApi');
const { isWebSearchEnabled, setWebSearchEnabled, refreshWebSearchSetting, resetWebSearchSettingForTests } = require('../src/knowledge/webSearchSetting');
const { bindTool } = require('../src/tools/toolHelpers');
const { createImpl } = require('../src/tools/searchLayeredKnowledge');

function routeStub(calls) {
    return async (query, options) => {
        calls.push(options);
        return { found: false, evidence: [], used_levels: [], web_used: false, answerable: false };
    };
}

async function run() {
    resetWebSearchSettingForTests();

    // Settings validation
    t.deepEqual(sanitizeSettingsPatch({ web_search_enabled: false }).patch, { web_search_enabled: false }, 'boolean false accepted');
    t.ok(sanitizeSettingsPatch({ web_search_enabled: 'no' }).errors.includes('web_search_enabled_invalid'), 'non-boolean rejected');

    // Default: enabled
    const store = createMemoryCostStore();
    setCostStoreForTests(store);
    t.equal((await store.getSettings()).web_search_enabled, true, 'default is web enabled');
    await refreshWebSearchSetting();
    t.equal(isWebSearchEnabled(), true, 'runtime default is enabled');

    // Saving through the API applies immediately in this process
    const api = createCostApi({
        sendJson: (res, status, body) => { res.status = status; res.body = body; },
        readJsonBody: async (req) => req.body,
        getStore: () => store,
    });
    const res = {};
    await api.handle({ method: 'PUT', headers: {}, body: { web_search_enabled: false } }, res, '/api/cost/settings', new URLSearchParams());
    t.equal(res.status, 200, 'settings PUT ok');
    t.equal(res.body.settings.web_search_enabled, false, 'persisted false');
    t.equal(isWebSearchEnabled(), false, 'runtime cache updated without waiting for refresh');

    // Knowledge tool: web level off, even with force_web
    const calls = [];
    const impl = createImpl(routeStub(calls));
    await impl({ query: 'Что такое терруар?', force_web: true }, {});
    t.equal(calls[0].allowWeb, false, 'search_wine_knowledge does not allow web when switched off');

    // Internet tools refused, search_place allowed
    let ran = [];
    const ctx = { log: () => {} };
    const tool = (name) => bindTool({ name, impl: async () => { ran.push(name); return { ok: true }; } }, ctx);
    const webResult = await tool('search_web')({ args: { query: 'x' }, generationId: 'g1' });
    t.equal(webResult.error, 'web_search_disabled', 'search_web refused');
    const pageResult = await tool('fetch_page')({ args: { url: 'https://wine.md' }, generationId: 'g1' });
    t.equal(pageResult.error, 'web_search_disabled', 'fetch_page refused');
    const placeResult = await tool('search_place')({ args: { name: 'Cricova' }, generationId: 'g1' });
    t.equal(placeResult.ok, true, 'search_place still works');
    t.deepEqual(ran, ['search_place'], 'only search_place executed');

    // Switch back on
    setWebSearchEnabled(true);
    calls.length = 0;
    await impl({ query: 'Что такое терруар?' }, {});
    t.equal(calls[0].allowWeb, true, 'web allowed again when switched on');
    ran = [];
    await tool('search_web')({ args: { query: 'x' }, generationId: 'g2' });
    t.deepEqual(ran, ['search_web'], 'search_web runs when switched on');

    resetWebSearchSettingForTests();
    setCostStoreForTests(null);
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('webSearchSetting tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

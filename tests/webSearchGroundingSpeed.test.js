'use strict';

// Web grounding is on the voice critical path: the request must skip the
// model's hidden thinking pass, cap its output, and really stop at the
// timeout (the abort signal used to be created but never passed on).

const t = require('./helpers/assertions');

async function run() {
    const sdkPath = require.resolve('@google/genai');
    const saved = require.cache[sdkPath];
    const requests = [];
    let behavior = 'ok';
    require.cache[sdkPath] = {
        id: sdkPath, filename: sdkPath, loaded: true,
        exports: {
            GoogleGenAI: class {
                constructor() {
                    this.models = {
                        generateContent: (request) => {
                            requests.push(request);
                            if (behavior === 'hang') return new Promise(() => {});
                            return Promise.resolve({ candidates: [{ content: { parts: [{ text: 'Vinho verde is a young Portuguese wine.' }] }, groundingMetadata: { webSearchQueries: ['vinho verde'], groundingChunks: [{ web: { uri: 'https://example.org/a', title: 'example.org' } }] } }] });
                        },
                    };
                }
            },
        },
    };
    const providerPath = require.resolve('../src/knowledge/webSearchProvider');
    delete require.cache[providerPath];
    try {
        const { geminiGroundingSearch, _resetForTests } = require('../src/knowledge/webSearchProvider');
        if (typeof _resetForTests === 'function') _resetForTests();

        await geminiGroundingSearch('что такое vinho verde', { apiKey: 'test-key' });
        const config = requests[0] && requests[0].config;
        t.ok(config, 'grounding request sent');
        t.deepEqual(config.tools, [{ googleSearch: {} }], 'still grounded with Google Search');
        t.equal(config.thinkingConfig && config.thinkingConfig.thinkingBudget, 0, 'no hidden thinking pass');
        t.ok(config.maxOutputTokens > 0 && config.maxOutputTokens <= 1000, 'output capped');
        t.ok(config.abortSignal && typeof config.abortSignal.aborted === 'boolean', 'abort signal passed to the SDK');

        behavior = 'hang';
        const started = Date.now();
        const result = await geminiGroundingSearch('население Кишинева 2026', { apiKey: 'test-key', timeoutMs: 150 });
        const took = Date.now() - started;
        t.equal(result.error, 'timeout', 'hanging search reports timeout');
        t.equal(result.found, false);
        t.ok(took < 1000, `returns at the deadline, not whenever the SDK gives up (${took} ms)`);
        t.equal(requests[requests.length - 1].config.abortSignal.aborted, true, 'request aborted');
    } finally {
        if (saved) require.cache[sdkPath] = saved; else delete require.cache[sdkPath];
        delete require.cache[providerPath];
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('webSearchGroundingSpeed tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

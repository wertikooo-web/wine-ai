'use strict';

const assert = require('assert');
const { VISUAL_DECISIONS, decideVisualIntent } = require('../src/visual/visualIntentGate');

function publishedIntent(overrides = {}) {
    return {
        type: 'wine_info',
        wineId: 'wine_aurelius_example',
        publicationStatus: 'published',
        evidenceSource: 'tool_result',
        confidence: 0.98,
        ...overrides,
    };
}

assert.strictEqual(
    decideVisualIntent({ intent: { type: 'general' } }).decision,
    VISUAL_DECISIONS.AVATAR_ONLY
);
assert.strictEqual(
    decideVisualIntent({ intent: { type: 'general' }, activeWineId: 'wine_old' }).decision,
    VISUAL_DECISIONS.CLEAR_VISUAL
);
assert.strictEqual(
    decideVisualIntent({ intent: publishedIntent() }).decision,
    VISUAL_DECISIONS.SHOW_WINE
);
assert.strictEqual(
    decideVisualIntent({
        activeWineId: 'wine_aurelius_example',
        intent: {
            type: 'follow_up',
            wineId: 'wine_aurelius_example',
            evidenceSource: 'active_context',
            confidence: 0.99,
        },
    }).decision,
    VISUAL_DECISIONS.KEEP_CURRENT_WINE
);
assert.strictEqual(
    decideVisualIntent({
        intent: publishedIntent({
            type: 'buy_wine',
            commerce: {
                status: 'active',
                availability: 'available',
                price: 350,
                orderUrl: 'https://shop.example.test/aurelius',
            },
        }),
    }).decision,
    VISUAL_DECISIONS.SHOW_WINE_WITH_COMMERCE
);
assert.strictEqual(
    decideVisualIntent({ intent: publishedIntent({ evidenceSource: 'assistant_text' }) }).decision,
    VISUAL_DECISIONS.AVATAR_ONLY
);
assert.strictEqual(
    decideVisualIntent({ intent: publishedIntent({ publicationStatus: 'draft' }) }).decision,
    VISUAL_DECISIONS.AVATAR_ONLY
);

console.log('visualIntentGate.test.js: evidence-gated visual decisions passed.');

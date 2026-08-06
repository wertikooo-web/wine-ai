'use strict';

const assert = require('assert');
const { extractWineCard } = require('../src/kos/wines/wineCatalogService');
const { recommendForWine } = require('../src/pairing/pairingEngine');

async function run() {
    const card = extractWineCard('<html><title>Viorica 2024 | Test Winery</title><body><h1>Viorica 2024</h1><p>Vin alb sec, citrice și flori. Winery: Test Winery</p></body></html>', 'https://example.com/viorica');
    assert.strictEqual(card.name, 'Viorica 2024');
    assert.strictEqual(card.vintage, '2024');
    assert.strictEqual(card.profile.color, 'white');
    assert.ok(card.profile.grapes.includes('viorica'));
    const result = recommendForWine({ wine: card.name, catalogProfiles: [{ id: 'wine_test', name: card.name, aliases: [card.name], ...card.profile }] });
    assert.strictEqual(result.found, true);
    assert.strictEqual(result.wine_style.name, card.name);
    assert.ok(result.dishes.length > 0);
    return { assertionCount: 7 };
}

module.exports = { run };

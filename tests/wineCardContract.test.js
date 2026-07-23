'use strict';

const assert = require('assert');
const { validatePublishedWineCard } = require('../src/wineCard/wineCardContract');

function validCard() {
    return {
        schemaVersion: 1,
        wineId: 'wine_aurelius_example',
        vintageId: 'vintage_aurelius_example_2022',
        publicationStatus: 'published',
        locale: 'ru',
        identity: {
            name: 'Aurelius Example',
            wineryId: 'winery_aurelius',
            wineryName: 'Aurelius',
            vintage: 2022,
            region: 'Codru, Moldova',
        },
        technical: {
            wineType: 'red',
            sweetness: 'dry',
            grapes: [{ name: 'Fetească Neagră', percentage: 100 }],
            alcoholPercentage: 13.5,
            servingTemperature: '16–18°',
        },
        presentation: {
            shortDescription: 'Verified description',
            aromas: ['blackberry', 'plum', 'oak'],
            pairings: ['duck', 'aged_cheese'],
        },
        media: {
            bottle: {
                url: 'https://media.example.test/aurelius.png',
                alt: 'Aurelius bottle',
                rightsStatus: 'approved',
            },
        },
        commerce: null,
        provenance: {
            verified: true,
            sourceIds: ['source_official_sheet'],
            updatedAt: '2026-07-23T00:00:00.000Z',
        },
    };
}

assert.deepStrictEqual(validatePublishedWineCard(validCard()), { valid: true, errors: [] });

const draft = validCard();
draft.publicationStatus = 'draft';
assert.strictEqual(validatePublishedWineCard(draft).valid, false);

const unverifiedImage = validCard();
unverifiedImage.media.bottle.rightsStatus = 'pending';
assert.strictEqual(validatePublishedWineCard(unverifiedImage).valid, false);

const invalidCommerce = validCard();
invalidCommerce.commerce = { status: 'draft', price: 350, currency: 'MDL', orderUrl: '' };
assert.strictEqual(validatePublishedWineCard(invalidCommerce).valid, false);

console.log('wineCardContract.test.js: published Wine Card contract checks passed.');

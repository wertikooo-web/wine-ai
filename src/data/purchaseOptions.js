'use strict';

// Structured "where to buy" data for wines — deliberately kept separate from
// the AI/knowledge layer. The model only ever decides WHEN to surface this
// block (see the trigger phrases in public/dashboard.html); the actual
// seller names, prices and links always come from here, never from the
// model's own text, so a hallucinated price or a stale link can't reach
// the user through the AI.
const PURCHASE_OPTIONS = {
    'dealul-de-aur-feteasca-neagra-reserve-2019': [
        {
            id: 'demo-winery-direct',
            wineId: 'dealul-de-aur-feteasca-neagra-reserve-2019',
            sellerName: 'Crama Dealul de Aur (продажа с винодельни)',
            sellerType: 'winery',
            url: 'https://example.com/demo-crama-dealul-de-aur/dealul-de-aur-reserve-2019',
            price: 350,
            currency: 'MDL',
            country: 'MD',
        },
        {
            id: 'demo-marketplace-wineshop',
            wineId: 'dealul-de-aur-feteasca-neagra-reserve-2019',
            sellerName: 'WineShop.md (демо-магазин)',
            sellerType: 'marketplace',
            url: 'https://example.com/demo-wineshop-md/dealul-de-aur-reserve-2019',
            price: 385,
            currency: 'MDL',
            country: 'MD',
        },
    ],
};

function getPurchaseOptions(wineId) {
    return PURCHASE_OPTIONS[wineId] || [];
}

module.exports = { getPurchaseOptions };

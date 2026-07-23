'use strict';

const { resolveAssetSet, resolveDescriptors, resolvePairings, resolveRegion } = require('./visualAssetRegistry');

// Controlled DEMO records: objective knowledge, commerce and visual bindings
// remain separate and are never filled from unrestricted model output.
const WINE_KNOWLEDGE = Object.freeze({
    'demo-wine-001': Object.freeze({
        wineId: 'demo-wine-001',
        name: 'Dealul de Aur Fetească Neagră Reserve',
        winery: 'Crama Dealul de Aur',
        vintage: '2019',
        regionId: 'codru',
        region: 'Codru, Moldova',
        grapes: ['Fetească Neagră'],
        servingTemperature: '16–18 °C',
        alcohol: '13.5%',
        shortDescription: 'Сухое красное демовино с тёмными ягодами и мягкими пряными оттенками.',
        aromaDescriptorIds: ['blackberry', 'plum', 'oak'],
        pairingIds: ['duck', 'cheese'],
    }),
    'demo-wine-002': Object.freeze({
        wineId: 'demo-wine-002',
        name: 'Codru Rosé',
        winery: 'Crama Dealul de Aur',
        vintage: '2023',
        regionId: 'codru',
        region: 'Codru, Moldova',
        grapes: ['Merlot', 'Fetească Neagră'],
        servingTemperature: '8–10 °C',
        alcohol: '12.5%',
        shortDescription: 'Свежее сухое демовино с ягодным ароматом и чистым прохладным послевкусием.',
        aromaDescriptorIds: ['strawberry', 'rose', 'citrus'],
        pairingIds: ['salmon', 'salad'],
    }),
    'demo-wine-003': Object.freeze({
        wineId: 'demo-wine-003',
        name: 'Ștefan Vodă Viorica',
        winery: 'Vinăria Ștefan',
        vintage: '2023',
        regionId: 'stefan-voda',
        region: 'Ștefan Vodă, Moldova',
        grapes: ['Viorica'],
        servingTemperature: '8–10 °C',
        alcohol: '12.0%',
        shortDescription: 'Ароматное сухое белое демовино с цветочными, грушевыми и цитрусовыми нотами.',
        aromaDescriptorIds: ['acacia', 'pear', 'citrus'],
        pairingIds: ['salmon', 'salad'],
    }),
});

const COMMERCE_CATALOG = Object.freeze({
    'product-demo-001': Object.freeze({
        productId: 'product-demo-001',
        wineId: 'demo-wine-001',
        orderUrl: 'https://example.com/winemd/demo-wine-001',
        qrUrl: 'https://example.com/winemd/demo-wine-001',
        availability: 'demo_available',
        price: 350,
        currency: 'MDL',
    }),
    'product-demo-002': Object.freeze({
        productId: 'product-demo-002',
        wineId: 'demo-wine-002',
        orderUrl: 'https://example.com/winemd/demo-wine-002',
        qrUrl: 'https://example.com/winemd/demo-wine-002',
        availability: 'demo_available',
        price: 245,
        currency: 'MDL',
    }),
    'product-demo-003': Object.freeze({
        productId: 'product-demo-003',
        wineId: 'demo-wine-003',
        orderUrl: '',
        qrUrl: '',
        availability: 'demo_unavailable',
        price: null,
        currency: 'MDL',
    }),
});

const VISUAL_BINDINGS = Object.freeze({
    'demo-wine-001': Object.freeze({ productId: 'product-demo-001', assetSetId: 'asset-dealul-reserve' }),
    'demo-wine-002': Object.freeze({ productId: 'product-demo-002', assetSetId: 'asset-codru-rose' }),
    'demo-wine-003': Object.freeze({ productId: 'product-demo-003', assetSetId: 'asset-stefan-viorica' }),
});

function chooseWineId(text = '') {
    const normalized = String(text).toLocaleLowerCase('ru');
    if (/(рыб|лосос|морепродукт|salmon|fish|pește)/u.test(normalized)) return 'demo-wine-002';
    if (/(бел|цветоч|viorica|white|alb)/u.test(normalized)) return 'demo-wine-003';
    return 'demo-wine-001';
}

function getValidatedPresentation(wineId) {
    const knowledge = WINE_KNOWLEDGE[wineId];
    const binding = VISUAL_BINDINGS[wineId];
    if (!knowledge || !binding) return null;
    const commerce = COMMERCE_CATALOG[binding.productId] || null;
    const assetSet = resolveAssetSet(binding.assetSetId);
    if (!assetSet) return null;
    return Object.freeze({
        knowledge,
        commerce,
        assetSetId: binding.assetSetId,
        assetSet,
        aromas: resolveDescriptors(knowledge.aromaDescriptorIds),
        pairings: resolvePairings(knowledge.pairingIds),
        region: resolveRegion(knowledge.regionId),
    });
}

module.exports = {
    WINE_KNOWLEDGE,
    COMMERCE_CATALOG,
    VISUAL_BINDINGS,
    chooseWineId,
    getValidatedPresentation,
};

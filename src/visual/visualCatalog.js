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

// Gate before selection: a wine card is a *smart continuation* of the
// conversation, not a reaction to the mic button. Without this check,
// chooseWineId() would fall through to a default for every turn — including
// "what is decanting?" or "tell me about Codru region" — which is exactly
// the reported bug (card fires on almost every reply). Only fire once the
// turn actually mentions a wine, a demo wine name, or a wine-recommendation
// cue (e.g. "что взять к утке").
// NOTE: \b is ASCII-only in JS regex, even with the /u flag — it does not
// recognize Cyrillic letters as word characters, so a Cyrillic \b silently
// never matches. Plain substrings are used for the Cyrillic branches instead.
//
// Deliberately NOT matching bare "вино"/"вина" (any вин[оаыуе] substring):
// "Как хранить вино?", "Чем красное вино отличается от белого?", and
// "Какие винодельни стоит посетить?" all contain that substring but must NOT
// show a wine card (generic wine-topic questions, not a specific-wine ask).
// The gate below only fires on a named demo wine, or an explicit
// recommendation/purchase cue — this is a keyword heuristic, not real intent
// resolution, so it won't catch every phrasing; see visualIntentGate.js /
// docs/BROLL_IMPLEMENTATION_PLAN.md for the real fix (verified wineId from a
// tool result, not text-sniffing).
const WINE_TOPIC_PATTERN = /(feteasc|dealul|codru\b|viorica|ștefan\s*vod[aă]|stefan\s*voda|rosé|розе|какое вино|что (взять|подойдёт|порекоменд)|посовету|порекоменд|купить|закажи|заказать)/iu;

function chooseWineId(text = '') {
    const normalized = String(text).toLocaleLowerCase('ru');
    if (!WINE_TOPIC_PATTERN.test(normalized)) return null;
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

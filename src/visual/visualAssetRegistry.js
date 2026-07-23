'use strict';

// The UI receives controlled public aliases and semantic asset identifiers,
// never arbitrary file names supplied by a model.
const ASSET_SETS = Object.freeze({
    'asset-dealul-reserve': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-dealul-reserve.png',
        fallbackUrl: '/visual-assets/bottle-fallback.svg',
    }),
    'asset-codru-rose': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-codru-rose.png',
        fallbackUrl: '/visual-assets/bottle-fallback.svg',
    }),
    'asset-stefan-viorica': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-stefan-viorica.png',
        fallbackUrl: '/visual-assets/bottle-fallback.svg',
    }),
});

const DESCRIPTOR_ASSETS = Object.freeze({
    blackberry: Object.freeze({ glyph: '🫐', label: 'Ежевика', color: '#54233d' }),
    plum: Object.freeze({ glyph: '🟣', label: 'Слива', color: '#74405e' }),
    oak: Object.freeze({ glyph: '🌳', label: 'Дуб', color: '#9b7049' }),
    strawberry: Object.freeze({ glyph: '🍓', label: 'Клубника', color: '#c85162' }),
    rose: Object.freeze({ glyph: '🌹', label: 'Роза', color: '#d88b9a' }),
    citrus: Object.freeze({ glyph: '🍋', label: 'Цитрус', color: '#d6a42d' }),
    acacia: Object.freeze({ glyph: '🌼', label: 'Акация', color: '#d9bd68' }),
    pear: Object.freeze({ glyph: '🍐', label: 'Груша', color: '#a9b64f' }),
});

const PAIRING_ASSETS = Object.freeze({
    duck: Object.freeze({ glyph: '🍽', label: 'Утка с ягодным соусом' }),
    cheese: Object.freeze({ glyph: '◒', label: 'Выдержанные сыры' }),
    salmon: Object.freeze({ glyph: '≈', label: 'Лосось и морепродукты' }),
    salad: Object.freeze({ glyph: '❧', label: 'Лёгкие салаты' }),
});

const REGION_ASSETS = Object.freeze({
    codru: Object.freeze({ label: 'Codru, Moldova', mapAsset: 'map-codru-stylized' }),
    'stefan-voda': Object.freeze({ label: 'Ștefan Vodă, Moldova', mapAsset: 'map-stefan-voda-stylized' }),
});

function resolveAssetSet(assetSetId) {
    return ASSET_SETS[assetSetId] || null;
}
function resolveDescriptors(ids) {
    return ids.map((id) => ({ id, ...DESCRIPTOR_ASSETS[id] })).filter((asset) => asset.label);
}
function resolvePairings(ids) {
    return ids.map((id) => ({ id, ...PAIRING_ASSETS[id] })).filter((asset) => asset.label);
}
function resolveRegion(regionId) {
    const asset = REGION_ASSETS[regionId];
    return asset ? { id: regionId, ...asset } : null;
}

module.exports = {
    ASSET_SETS,
    DESCRIPTOR_ASSETS,
    PAIRING_ASSETS,
    REGION_ASSETS,
    resolveAssetSet,
    resolveDescriptors,
    resolvePairings,
    resolveRegion,
};

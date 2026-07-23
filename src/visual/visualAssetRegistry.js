'use strict';

// The UI receives controlled public aliases and semantic asset identifiers,
// never arbitrary file names supplied by a model.
const ASSET_SETS = Object.freeze({
    'asset-dealul-reserve': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-dealul-reserve.png',
        fallbackUrl: '/visual-assets/bottle-fallback.svg',
    }),
    // The original .png files at these same URLs (never committed — see the
    // commit that restored them) all turned out to be crops of the same
    // AI-generated red-wine mockup image, just wrapped in different UI
    // framing. .vs-bottle's CSS crop (object-fit:cover / object-position:
    // left center — see public/visual/visual-story.css) always grabbed the
    // same red bottle regardless of which "wine" it was supposedly
    // illustrating. Replaced with purpose-generated photos matching the red
    // bottle's studio-shot style (a hand-drawn SVG placeholder briefly
    // stood in here in between).
    // ?v=3 cache-busts: the static route in server.js sets
    // cache-control: public, max-age=3600 on these files, and this exact
    // URL served three different images within the same hour while this
    // asset was being iterated on — a browser (or intermediate cache) that
    // fetched it earlier in that window would keep the stale response for
    // up to an hour without a change in URL. Bump this query value any time
    // these specific files are replaced again.
    'asset-codru-rose': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-codru-rose.png?v=3',
        fallbackUrl: '/visual-assets/bottle-fallback.svg',
    }),
    'asset-stefan-viorica': Object.freeze({
        type: 'static-image',
        bottleUrl: '/visual-assets/bottle-stefan-viorica.png?v=3',
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

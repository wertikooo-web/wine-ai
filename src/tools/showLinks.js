'use strict';

// show_links: puts VERIFIED clickable links into the /lite chat as text --
// winery website, map (location), Instagram, Facebook, excursion booking,
// the winery's and the wine's pages on WineMD, plus the wine's photo.
//
// The model never writes a URL. It calls this tool with the name the guest
// asked about; links come only from data/demo-links (Ghidul vinului +
// wine.md + the winery site's own social links) and the Visual Companion
// wine catalog. The map link is a Google Maps search for the winery's name
// (a search, not a claimed address). Nothing is invented: a kind without a
// verified link is reported as missing so the model can say so honestly.

const { requireNonEmptyString } = require('./toolHelpers');
const wineryLinks = require('../companion/wineryLinks');
const { findWinesInTexts, getCompanionStore, safeHttpsUrl } = require('../companion/companionCatalog');
const { recordLinkEvent } = require('../analytics/linkEvents');

const KINDS = Object.freeze(['site', 'map', 'instagram', 'facebook', 'tours', 'winemd', 'wine_page']);

const declaration = {
    name: 'show_links',
    description: 'Show verified, clickable links in the chat (as text) for a winery or wine the user asks about: official website, map / location, Instagram, Facebook, excursion booking, the page on WineMD, and the wine photo. Call it whenever the user asks for a link, website, address, location or map, Instagram, Facebook, where to buy, or how to book a tour. Never say, spell or invent a URL yourself.',
    parameters: {
        type: 'OBJECT',
        properties: {
            name: { type: 'STRING', description: 'The winery or wine name exactly as discussed, e.g. "Purcari", "Negru de Purcari", "Castel Mimi".' },
            kinds: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Optional: which links were asked for: site, map, instagram, facebook, tours, winemd, wine_page. Omit to show all available.' },
        },
        required: ['name'],
    },
};

function mapSearchUrl(name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, Moldova`)}`;
}

function wineryByName(name) {
    const hit = wineryLinks.findWineriesInTexts([name], wineryLinks.loadWineries(), 1)[0];
    return hit || null;
}

function wineryLinkList(w) {
    const byType = Object.fromEntries(w.ctas.map((c) => [c.type, c]));
    const out = [];
    if (byType.VISIT_WINERY_SITE) out.push({ kind: 'site', url: byType.VISIT_WINERY_SITE.url });
    out.push({ kind: 'map', url: mapSearchUrl(w.name) });
    if (w.instagram) out.push({ kind: 'instagram', url: w.instagram });
    if (w.facebook) out.push({ kind: 'facebook', url: w.facebook });
    if (byType.BOOK_TOUR) out.push({ kind: 'tours', url: byType.BOOK_TOUR.url, info: byType.BOOK_TOUR.info || null });
    if (byType.WINERY_ON_WINEMD) out.push({ kind: 'winemd', url: byType.WINERY_ON_WINEMD.url });
    return out;
}

async function impl(args, toolContext = {}) {
    const name = requireNonEmptyString(args.name, 'name').slice(0, 120);
    const wanted = Array.isArray(args.kinds) ? args.kinds.map((k) => String(k).toLowerCase()).filter((k) => KINDS.includes(k)) : [];
    if (toolContext.companionScreen !== true || typeof toolContext.emitToClient !== 'function') {
        return { found: false, shown_in_chat: [], instruction: 'This conversation has no chat screen to show links. Do not read or invent URLs; offer to describe how to find the winery instead.' };
    }

    let wine = null;
    const wineHit = findWinesInTexts([name], undefined, 1)[0];
    if (wineHit) {
        try { wine = await getCompanionStore().get(wineHit.wineId); } catch { wine = null; }
    }
    const winery = wineryByName(name) || (wine ? wineryByName(wine.wineryName) : null);

    let links = [];
    if (wine && safeHttpsUrl(wine.productUrl)) links.push({ kind: 'wine_page', url: safeHttpsUrl(wine.productUrl) });
    if (winery) links.push(...wineryLinkList(winery));
    else if (wine && safeHttpsUrl(wine.wineryUrl)) links.push({ kind: 'site', url: safeHttpsUrl(wine.wineryUrl) });
    links = links.map((l) => ({ ...l, url: l.kind === 'map' ? l.url : safeHttpsUrl(l.url) })).filter((l) => l.url);
    if (wanted.length) {
        const filtered = links.filter((l) => wanted.includes(l.kind));
        if (filtered.length) links = filtered;
    }
    const missing = wanted.filter((k) => !links.some((l) => l.kind === k));

    if (!links.length) {
        recordLinkEvent({ event: 'link_missing', entityType: 'unknown', detail: `show_links: ${name}` });
        return { found: false, shown_in_chat: [], missing: wanted, instruction: 'There is no verified link for this yet. Say so briefly and honestly; never read or invent a URL.' };
    }

    const title = wine ? `${wine.wineName}${wine.wineryName ? ` — ${wine.wineryName}` : ''}` : winery.name;
    const entityType = wine ? 'wine' : 'winery';
    const entityId = wine ? wine.wineId : winery.wineryId;
    toolContext.emitToClient({
        type: 'companion.links',
        generation_id: toolContext._currentGenerationId || null,
        entity_type: entityType,
        entity_id: entityId,
        title,
        image_url: wine ? safeHttpsUrl(wine.imageUrl) : null,
        price: wine && wine.price && wine.currency ? `${wine.price} ${wine.currency}` : null,
        links,
    });
    recordLinkEvent({ event: 'link_resolved', entityType, entityId, entityName: title });
    return {
        found: true,
        shown_in_chat: links.map((l) => l.kind),
        missing,
        instruction: 'The links are now shown in the chat as clickable text. Say briefly that you have put the links in the chat (name which ones, e.g. site, map, Instagram). Never read, spell or invent a URL.' + (missing.length ? ` There is no verified link for: ${missing.join(', ')} -- say so honestly.` : ''),
    };
}

module.exports = { declaration, impl, KINDS, mapSearchUrl };

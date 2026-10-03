'use strict';

// Live availability/price lookup on wine.md — deliberately NOT part of the
// static knowledge base (see manual-wine-md-platform.md): a shop catalog
// changes daily, so baking it into knowledge/source/*.md would go stale
// almost immediately. This hits the live site at query time instead.
//
// wine.md's product grid is client-side rendered (a plain fetch()+cheerio
// GET of a catalog page returns an empty shell, same issue as ATU/Vinaria
// din Vale — see the manual-*.md docs for those), so scraping catalog
// pages doesn't work. Its search box, however, is powered by a public
// MODX/msearch2 AJAX endpoint that returns real JSON once a session
// cookie is present:
//   1. GET https://wine.md/ to receive a PHPSESSID cookie.
//   2. POST that cookie to assets/components/msearch2/action.php with
//      action=search, the form's `key` token (read from the site's own
//      inline <script> config — see docs/... none yet, just this
//      comment), pageId=1, and query=<search text>.
// `SEARCH_FORM_KEY` is that token; it's a static per-form identifier
// baked into wine.md's page templates, not a secret or a session value —
// if wine.md ever redeploys with a different form config this will need
// to be re-read from https://wine.md/'s page source (search for
// "mse2FormConfig") and updated here.
//
// TODO(when wine.md provides a partner API): swap this whole
// implementation for a real API call — the declaration/impl contract can
// stay the same.
const { requireNonEmptyString } = require('./toolHelpers');
const { recordLinkEvent } = require('../analytics/linkEvents');

const declaration = {
    name: 'check_wine_md_availability',
    description: 'Live-check whether a specific wine is currently listed on wine.md, a Moldovan online wine shop. Use this ONLY when the user explicitly asks about buying, price, or availability on wine.md specifically — for general facts about a wine or winery, use search_wine_knowledge instead. This is a real-time lookup against wine.md\'s own search, not the static knowledge base, so results reflect what\'s on the site right now — but it can still miss items if the query wording doesn\'t match their catalog text. Never claim a wine is unavailable just because this found nothing — say the search didn\'t find it and suggest looking directly on wine.md.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'Producer/winery name and/or wine name and/or vintage to look for, e.g. "Novak Feteasca Regala 2022".',
            },
        },
        required: ['query'],
    },
};

const HOME_URL = 'https://wine.md/';
const SEARCH_URL = 'https://wine.md/assets/components/msearch2/action.php';
const SEARCH_FORM_KEY = '4684895e8cda145fc7375d8d40ad71fa79312af8';
const REQUEST_TIMEOUT_MS = 10000;
const USER_AGENT = 'WineAIRealtimeBot/0.1 (+https://github.com/wertikooo-web/wine-ai; contact via repo issues)';

function withTimeout(promiseFactory) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return promiseFactory(controller.signal).finally(() => clearTimeout(timeout));
}

async function getSessionCookie() {
    const response = await withTimeout((signal) => fetch(HOME_URL, {
        headers: { 'User-Agent': USER_AGENT },
        signal,
    }));
    const rawCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    // Only the session cookie is needed to make the search endpoint work —
    // the cart-tracking cookies wine.md also sets aren't relevant here and
    // are dropped to keep the request minimal.
    const sessionCookie = rawCookies.find((c) => c.startsWith('PHPSESSID='));
    return sessionCookie ? sessionCookie.split(';')[0] : '';
}

async function searchWineMd(query, cookie) {
    const body = new URLSearchParams({
        action: 'search',
        key: SEARCH_FORM_KEY,
        pageId: '1',
        query,
    });
    const response = await withTimeout((signal) => fetch(SEARCH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            'Referer': HOME_URL,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body.toString(),
        signal,
    }));
    if (!response.ok) {
        throw Object.assign(new Error(`http_${response.status}`), { code: 'fetch_failed' });
    }
    const data = await response.json();
    if (!data.success) {
        throw Object.assign(new Error(data.message || 'search_failed'), { code: 'search_failed' });
    }
    return data.data?.results || [];
}

// The endpoint returns an HTML-ish `label` (bolded matches, a weight
// count) meant for a JS autocomplete dropdown — strip it down to the
// plain product name (`value`) rather than passing markup to the model.
// Only https links on wine.md itself are kept (relative URLs resolved).
function toResult(raw) {
    let url = null;
    try {
        const parsed = new URL(String(raw.url || ''), HOME_URL);
        if (parsed.protocol === 'https:' && /(^|\.)wine\.md$/i.test(parsed.hostname)) url = parsed.href;
    } catch { url = null; }
    return { title: String(raw.value || '').replace(/<[^>]*>/g, '').trim().slice(0, 120), url };
}

const MAX_SHOWN = 3;
const NO_CARD = ' Never say you are showing a card or a picture -- only the links in the chat.';

// Lite chat (production 2026-10-03): the model found the wine on wine.md,
// said it was "showing the card", and nothing appeared -- this tool never
// put anything on screen. Found products now go into the chat as clickable
// links (the same companion.links block show_links uses); the model gets
// the titles only, never the URLs.
function showInChat(results, toolContext) {
    if (!toolContext || toolContext.companionScreen !== true || typeof toolContext.emitToClient !== 'function') return [];
    const shown = [];
    for (const r of results) {
        if (!r.url || !r.title || shown.length >= MAX_SHOWN) continue;
        toolContext.emitToClient({
            type: 'companion.links',
            generation_id: toolContext._currentGenerationId || null,
            entity_type: 'wine',
            entity_id: `winemd:${r.url.replace(/^https:\/\/(www\.)?wine\.md\//i, '').slice(0, 80)}`,
            title: r.title,
            image_url: null,
            price: null,
            links: [{ kind: 'wine_page', url: r.url }],
        });
        recordLinkEvent({ event: 'link_resolved', entityType: 'wine', entityId: r.url, entityName: r.title });
        shown.push(r.title);
    }
    return shown;
}

async function impl(args, toolContext = {}) {
    const query = requireNonEmptyString(args.query, 'query');
    try {
        const cookie = await getSessionCookie();
        const results = (await searchWineMd(query, cookie)).slice(0, 5).map(toResult);
        if (!results.length) {
            return {
                found: false,
                results: [],
                note: 'The live search on wine.md found nothing for this wording. Say so briefly (do not claim the wine is unavailable), and offer to put the winery\'s own links in the chat (show_links with the winery name).' + NO_CARD + ' Never read or invent a URL.',
            };
        }
        const shown = showInChat(results, toolContext);
        return {
            found: true,
            results: results.map((r) => ({ title: r.title })),
            shown_in_chat: shown,
            note: (shown.length
                ? `The wine.md links for: ${shown.join('; ')} are now shown in the chat as clickable text. Say briefly that you have put the wine.md link(s) in the chat.`
                : 'This conversation has no chat screen for links; name the wine as listed on wine.md and suggest finding it there.')
                + NO_CARD + ' Never read, spell or invent a URL. Tell the user to confirm final price/stock on the site before buying.',
        };
    } catch (error) {
        return {
            found: false,
            results: [],
            error: true,
            note: `Live search against wine.md failed (${error.message}) — do not claim the wine is unavailable, just say the live check didn't work right now and offer the winery's own links (show_links).${NO_CARD}`,
        };
    }
}

module.exports = { declaration, impl };

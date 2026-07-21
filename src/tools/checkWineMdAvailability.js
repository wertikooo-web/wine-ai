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

const declaration = {
    name: 'check_wine_md_availability',
    description: 'Live-check whether a specific wine is currently listed on wine.md, a Moldovan online wine shop (a possible future project partner). Use this ONLY when the user explicitly asks about buying, price, or availability on wine.md specifically — for general facts about a wine or winery, use search_wine_knowledge instead. This is a real-time lookup against wine.md\'s own search, not the static knowledge base, so results reflect what\'s on the site right now — but it can still miss items if the query wording doesn\'t match their catalog text. Never claim a wine is unavailable just because this found nothing — say the search didn\'t find it and suggest looking directly on wine.md.',
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
function toResult(raw) {
    return { title: raw.value, url: raw.url };
}

async function impl(args) {
    const query = requireNonEmptyString(args.query, 'query');
    try {
        const cookie = await getSessionCookie();
        const results = await searchWineMd(query, cookie);
        return {
            found: results.length > 0,
            results: results.slice(0, 5).map(toResult),
            note: 'Live search against wine.md — reflects the current catalog, but always tell the user to confirm final price/stock directly on the site before they buy.',
        };
    } catch (error) {
        return {
            found: false,
            results: [],
            error: true,
            note: `Live search against wine.md failed (${error.message}) — do not claim the wine is unavailable, just say the live check didn't work right now and suggest wine.md directly.`,
        };
    }
}

module.exports = { declaration, impl };

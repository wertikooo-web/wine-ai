'use strict';

/**
 * Wine.md URL Classifier — classifies wine.md URLs by type and priority.
 * Used for selective ingestion: only relevant pages are crawled.
 */

const { URL } = require('url');

/**
 * URL pattern rules for wine.md classification.
 * Patterns are checked in order; first match wins.
 */
const WINE_MD_URL_PATTERNS = [
    // === SKIP PATTERNS (checked first) ===

    // Pagination
    { pattern: /[?&](?:page|p|offset|start)=\d+/i, type: 'pagination', priority: null, skip_reason: 'pagination' },
    { pattern: /\/page\/\d+/i, type: 'pagination', priority: null, skip_reason: 'pagination' },

    // Filters and sort
    { pattern: /[?&](?:filter|sort|order|view|grid|layout)=/i, type: 'filters_and_sort', priority: null, skip_reason: 'filters_and_sort' },

    // Search
    { pattern: /\/search(?:\/|$|\?)/i, type: 'search', priority: null, skip_reason: 'search' },
    { pattern: /[?&]q=/i, type: 'search', priority: null, skip_reason: 'search' },

    // Account, cart, checkout
    { pattern: /\/(?:cart|checkout|account|login|register|profile|orders|wishlist)(?:\/|$|\?)/i, type: 'account_cart_checkout', priority: null, skip_reason: 'account_cart_checkout' },

    // Technical / admin
    { pattern: /\/wp-(?:admin|content|includes)(?:\/|$)/i, type: 'technical', priority: null, skip_reason: 'technical' },
    { pattern: /\/(?:api|feed|xmlrpc|cron|wp-json)(?:\/|$|\?)/i, type: 'technical', priority: null, skip_reason: 'technical' },
    { pattern: /\.(?:json|xml|rss|atom|css|js|ico|txt)(?:\?|$)/i, type: 'technical', priority: null, skip_reason: 'technical' },

    // Service pages (shipping, returns, etc.)
    { pattern: /\/serviciul-clienti(?:\/|$|\?)/i, type: 'technical', priority: null, skip_reason: 'service_page' },

    // === PRIORITY 100: Wine products ===

    // Wine.md catalog wine pages (actual products with specific wine name)
    // /catalog/wine/vinuri-albe/aligote/agrici-wine-aligote-and-chardonnay
    { pattern: /\/catalog\/wine\/[^/]+\/[^/]+\/[^/]+(?:\/|$)/i, type: 'wine_product', priority: 100 },

    // Sparkling wine products
    // /catalog/vinuri-spumante/muscat/vinaria-poiana-muscat-demisec
    { pattern: /\/catalog\/vinuri-spumante\/[^/]+\/[^/]+(?:\/|$)/i, type: 'wine_product', priority: 100 },

    // Spirits products (cognac, divin, brandy)
    // /catalog/spirtoase/cognac-6369/cricova-divin-7
    { pattern: /\/catalog\/spirtoase\/[^/]+\/[^/]+(?:\/|$)/i, type: 'wine_product', priority: 100 },

    // Root-level wine product pages (pattern: /slug-slug-NUMBER or /slug-slug)
    // /purcari-negru-de-purcari-2707, /cricova-sauvignon-blanc-prestige-2707
    // /radacini-ancellotta, /echinoctius-6492
    { pattern: /^\/[a-z0-9]+(?:-[a-z0-9]+)+(?:-\d+)?$/i, type: 'wine_product', priority: 100 },

    // Single-segment products with numbers
    // /echinoctius-6492
    { pattern: /^\/[a-z0-9]+-\d+$/i, type: 'wine_product', priority: 100 },

    // Standard wine product pages
    { pattern: /\/wines?(?:\/|$)/i, type: 'wine_product', priority: 100 },
    { pattern: /\/vin(?:a|o|y|e|u)?(?:\/|$)/i, type: 'wine_product', priority: 100 },
    { pattern: /\/product(?:s)?(?:\/|$)/i, type: 'wine_product', priority: 100 },

    // === PRIORITY 80: Supporting pages ===

    // Contact pages
    { pattern: /\/contacts?(?:\/|$|\?)/i, type: 'contact_page', priority: 80 },
    { pattern: /\/about(?:-us)?(?:\/|$|\?)/i, type: 'contact_page', priority: 80 },
    { pattern: /\/brand(?:\/|$|\?)/i, type: 'contact_page', priority: 80 },

    // Grape pages
    { pattern: /\/grapes?(?:\/|$)/i, type: 'grape_page', priority: 80 },
    { pattern: /\/sort(?:a|o|y|e|u)?(?:\/|$)/i, type: 'grape_page', priority: 80 },

    // Region pages
    { pattern: /\/regions?(?:\/|$)/i, type: 'region_page', priority: 80 },
    { pattern: /\/region(?:y|a|i|e|u)?(?:\/|$)/i, type: 'region_page', priority: 80 },

    // Tourism pages
    { pattern: /\/tourism(?:\/|$)/i, type: 'editorial_article', priority: 80 },
    { pattern: /\/pachete-turistice(?:\/|$)/i, type: 'editorial_article', priority: 80 },

    // Excursion / experience pages
    { pattern: /\/(?:excursion|excursie|experience|degustatie)(?:\/|$|\?)/i, type: 'editorial_article', priority: 80 },

    // Tasting room
    { pattern: /\/tasting-room(?:\/|$|\?)/i, type: 'editorial_article', priority: 80 },

    // Vinoteca
    { pattern: /\/vinoteca(?:\/|$|\?)/i, type: 'editorial_article', priority: 80 },

    // Menu
    { pattern: /\/menyu(?:\/|$|\?)/i, type: 'editorial_article', priority: 40 },

    // === PRIORITY 40: Editorial ===

    // Editorial articles
    { pattern: /\/blog(?:\/|$)/i, type: 'editorial_article', priority: 40 },
    { pattern: /\/news(?:\/|$)/i, type: 'editorial_article', priority: 40 },
    { pattern: /\/articles?(?:\/|$)/i, type: 'editorial_article', priority: 40 },
    { pattern: /\/novosti(?:\/|$)/i, type: 'editorial_article', priority: 40 },
    { pattern: /\/statji(?:\/|$)/i, type: 'editorial_article', priority: 40 },

    // Events
    { pattern: /\/events?(?:\/|$)/i, type: 'editorial_article', priority: 40 },

    // Content pages (excursions, wine info, etc.)
    { pattern: /\/content(?:\/|$)/i, type: 'editorial_article', priority: 40 },

    // Collections (curated wine lists)
    { pattern: /\/collections?(?:\/|$)/i, type: 'editorial_article', priority: 40 },

    // === SKIP: Low-value catalog pages ===

    // Catalog root
    { pattern: /^https?:\/\/wine\.md\/catalog\/?$/i, type: 'category_page', priority: null, skip_reason: 'catalog_root' },

    // Catalog index pages (category navigation, not products)
    { pattern: /\/catalog\/wine\/(?:vinuri-[^/]+|spirtoase|gourmet|cadouri|seturi)(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'category_index' },

    // Catalog subcategory pages (e.g., /catalog/wine/vinuri-albe/, /catalog/wine/vinuri-rosii/)
    // These are navigation pages, not product pages
    { pattern: /\/catalog\/wine\/vinuri-[^/]+(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'category_index' },

    // Sparkling wine category pages
    { pattern: /\/catalog\/vinuri-spumante(?:\/[^/]+)?(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'category_index' },

    // Spirits category pages
    { pattern: /\/catalog\/spirtoase(?:\/[^/]+)?(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'category_index' },

    // Accessories
    { pattern: /\/catalog\/accesorii(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'accessories' },

    // Gifts
    { pattern: /\/catalog\/gifts(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'gifts' },

    // Gourmet products
    { pattern: /\/catalog\/produse-gourmet(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'gourmet' },

    // Tickets
    { pattern: /\/catalog\/tickets(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'tickets' },

    // Beer
    { pattern: /\/catalog\/bere-litra(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'beer' },

    // Promotions
    { pattern: /\/catalog\/promotii(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'promotions' },

    // Catalog subcategories (ialoveni)
    { pattern: /\/catalog\/ialoveni-[^/]+(?:\/|$)/i, type: 'category_page', priority: null, skip_reason: 'catalog_subcategory' },
];

/**
 * Query parameters to strip from URLs for deduplication.
 */
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'fbclid', 'gclid', 'mc_cid', 'mc_eid',
    'ref', 'referrer', 'source',
    'phpsessid', 'sid', 'session_id',
    'timestamp', 'ts', 'rand', 'nonce',
]);

/**
 * Classify a wine.md URL.
 * @param {string} urlString - The URL to classify
 * @returns {{ type: string, priority: number|null, skip_reason: string|null, normalized_url: string }}
 */
function classifyWineMdUrl(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return { type: 'unknown', priority: null, skip_reason: 'invalid_url', normalized_url: urlString };
    }

    // Only wine.md domain
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'wine.md') {
        return { type: 'unknown', priority: null, skip_reason: 'wrong_domain', normalized_url: urlString };
    }

    // Normalize: strip tracking params, fragments
    const cleanParams = new URLSearchParams();
    for (const [key, value] of parsed.searchParams) {
        if (!TRACKING_PARAMS.has(key.toLowerCase())) {
            cleanParams.set(key, value);
        }
    }
    const paramString = cleanParams.toString();
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
    const normalizedUrl = `https://wine.md${normalizedPath}${paramString ? '?' + paramString : ''}`;

    // Classify by path patterns
    const path = parsed.pathname;
    for (const rule of WINE_MD_URL_PATTERNS) {
        if (rule.pattern.test(path) || rule.pattern.test(urlString)) {
            return {
                type: rule.type,
                priority: rule.priority,
                skip_reason: rule.skip_reason || null,
                normalized_url: normalizedUrl,
            };
        }
    }

    // Default: unknown, but still crawlable if on wine.md
    return { type: 'unknown', priority: 40, skip_reason: null, normalized_url: normalizedUrl };
}

/**
 * Deduplicate URLs by normalized form.
 * @param {string[]} urls
 * @returns {string[]} Unique normalized URLs
 */
function deduplicateUrls(urls) {
    const seen = new Set();
    const result = [];
    for (const url of urls) {
        const { normalized_url } = classifyWineMdUrl(url);
        const key = normalized_url.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(url);
        }
    }
    return result;
}

/**
 * Get classification statistics for a list of URLs.
 * @param {string[]} urls
 * @returns {{ by_type: Object, selected: string[], skipped: string[], total: number }}
 */
function classifyStats(urls) {
    const byType = {};
    const selected = [];
    const skipped = [];

    for (const url of urls) {
        const classification = classifyWineMdUrl(url);
        const { type, priority, skip_reason } = classification;

        if (!byType[type]) {
            byType[type] = { count: 0, selected: 0, skipped: 0, examples: [] };
        }
        byType[type].count++;

        if (byType[type].examples.length < 10) {
            byType[type].examples.push({ url, priority, skip_reason });
        }

        if (skip_reason) {
            byType[type].skipped++;
            skipped.push({ url, type, skip_reason });
        } else {
            byType[type].selected++;
            selected.push({ url, type, priority });
        }
    }

    return { by_type: byType, selected, skipped, total: urls.length };
}

module.exports = {
    classifyWineMdUrl,
    deduplicateUrls,
    classifyStats,
    WINE_MD_URL_PATTERNS,
    TRACKING_PARAMS,
};

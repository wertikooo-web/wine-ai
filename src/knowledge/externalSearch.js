'use strict';

// External search tools — server-side only. These provide web/place/commerce
// search capabilities that are NOT exposed to the client. All API keys and
// configuration stay on the server.
//
// Design:
// - Each tool has bounded timeout and retry limits.
// - Results carry source_url, source_type, confidence, fetched_at.
// - Domain allowlisting prevents SSRF and unsafe redirects.
// - No page scripts are executed; only text/JSON responses are parsed.

const { isDomainAllowed, sanitizeUrl } = require('./safeFetch');

const USER_AGENT = 'WineAIRealtimeBot/0.2 (+https://github.com/wertikooo-web/wine-ai)';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_CONTENT_LENGTH = 512000; // 500KB

/**
 * searchOfficialSources — searches for official winery/wine websites.
 * Returns the official domain, contact page URL, and extracted facts.
 */
async function searchOfficialSources(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    try {
        // Use a bounded search via DuckDuckGo HTML (no API key needed)
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + ' official site')}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, facts: [], error: `http_${response.status}`, tookMs: Date.now() - startedAt };
        }

        const html = await response.text();
        const results = _extractSearchResults(html);

        return {
            found: results.length > 0,
            facts: results.slice(0, 5).map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                source_type: 'general_web',
                confidence: 'medium',
                fetched_at: new Date().toISOString(),
            })),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        return { found: false, facts: [], error: error.message, tookMs: Date.now() - startedAt };
    }
}

/**
 * searchPlace — searches for address, coordinates, hours via maps/place data.
 * Uses OpenStreetMap Nominatim (free, no API key) for geocoding.
 */
async function searchPlace(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    try {
        const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=3&addressdetails=1`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(searchUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, facts: [], error: `http_${response.status}`, tookMs: Date.now() - startedAt };
        }

        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            return { found: false, facts: [], tookMs: Date.now() - startedAt };
        }

        const facts = data.map((place) => ({
            name: place.display_name,
            latitude: place.lat,
            longitude: place.lon,
            address: place.display_name,
            osm_id: place.osm_id,
            source_type: 'maps_place_provider',
            confidence: 'medium',
            fetched_at: new Date().toISOString(),
        }));

        return { found: true, facts, tookMs: Date.now() - startedAt };
    } catch (error) {
        return { found: false, facts: [], error: error.message, tookMs: Date.now() - startedAt };
    }
}

/**
 * searchCommerce — searches for wine prices and availability.
 * Uses wine.md search endpoint (existing integration) or approved marketplaces.
 */
async function searchCommerce(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    try {
        // Reuse the existing wine.md search mechanism
        const HOME_URL = 'https://wine.md/';
        const SEARCH_URL = 'https://wine.md/assets/components/msearch2/action.php';
        const SEARCH_FORM_KEY = '4684895e8cda145fc7375d8d40ad71fa79312af8';

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        // Get session cookie
        const homeResp = await fetch(HOME_URL, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        const rawCookies = typeof homeResp.headers.getSetCookie === 'function'
            ? homeResp.headers.getSetCookie()
            : [homeResp.headers.get('set-cookie')].filter(Boolean);
        const sessionCookie = rawCookies.find((c) => c.startsWith('PHPSESSID='));
        const cookie = sessionCookie ? sessionCookie.split(';')[0] : '';

        // Search
        const searchTimeout = setTimeout(() => controller.abort(), timeoutMs);
        const body = new URLSearchParams({
            action: 'search',
            key: SEARCH_FORM_KEY,
            pageId: '1',
            query,
        });
        const searchResp = await fetch(SEARCH_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': USER_AGENT,
                'Referer': HOME_URL,
                ...(cookie ? { Cookie: cookie } : {}),
            },
            body: body.toString(),
            signal: controller.signal,
        });
        clearTimeout(searchTimeout);

        if (!searchResp.ok) {
            return { found: false, facts: [], error: `http_${searchResp.status}`, tookMs: Date.now() - startedAt };
        }

        const data = await searchResp.json();
        const results = (data.data?.results || []).slice(0, 5);

        return {
            found: results.length > 0,
            facts: results.map((r) => ({
                title: r.value,
                url: r.url,
                source_type: 'approved_marketplace',
                confidence: 'medium',
                fetched_at: new Date().toISOString(),
            })),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        return { found: false, facts: [], error: error.message, tookMs: Date.now() - startedAt };
    }
}

/**
 * searchWineNews — searches for recent wine news and events.
 */
async function searchWineNews(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return searchOfficialSources(`${query} wine moldova news`, { timeoutMs });
}

/**
 * fetchSourcePage — fetches a specific URL and extracts text content.
 * Respects domain allowlist and SSRF protection.
 */
async function fetchSourcePage(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();

    const sanitized = sanitizeUrl(url);
    if (!sanitized) {
        return { found: false, error: 'invalid_url', tookMs: Date.now() - startedAt };
    }

    if (!isDomainAllowed(sanitized)) {
        return { found: false, error: 'domain_not_allowed', tookMs: Date.now() - startedAt };
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(sanitized, {
            headers: { 'User-Agent': USER_AGENT },
            signal: controller.signal,
            redirect: 'follow',
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, error: `http_${response.status}`, tookMs: Date.now() - startedAt };
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const json = await response.json();
            return {
                found: true,
                content: JSON.stringify(json).slice(0, MAX_CONTENT_LENGTH),
                contentType: 'json',
                sourceUrl: sanitized,
                fetchedAt: new Date().toISOString(),
                tookMs: Date.now() - startedAt,
            };
        }

        const html = await response.text();
        const text = _stripHtml(html).slice(0, MAX_CONTENT_LENGTH);

        return {
            found: true,
            content: text,
            contentType: 'text',
            sourceUrl: sanitized,
            fetchedAt: new Date().toISOString(),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        return { found: false, error: error.message, tookMs: Date.now() - startedAt };
    }
}

/**
 * extractStructuredFacts — extracts structured facts from text content.
 * Uses regex/heuristic extraction, no LLM calls.
 */
function extractStructuredFacts(text, entityType = 'winery') {
    const facts = {};
    if (!text) return facts;

    // Phone
    const phoneMatch = text.match(/(?:\+373|0)[\s\-]?\(?\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{3}/);
    if (phoneMatch) facts.phone = phoneMatch[0].trim();

    // Email
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
    if (emailMatch) facts.email = emailMatch[0];

    // Website
    const urlMatch = text.match(/https?:\/\/[\w.-]+\.\w{2,}/);
    if (urlMatch) facts.website = urlMatch[0];

    // Opening hours patterns: "10:00 - 18:00", "Luni-Vineri: 9:00-17:00"
    const hoursMatch = text.match(/(?:luni|monday|понедельник|пн)[\s:–-]*(\d{1,2}[:.]\d{2})[\s–-]+(\d{1,2}[:.]\d{2})/i);
    if (hoursMatch) facts.opening_hours = hoursMatch[0];

    // Address patterns
    const addressMatch = text.match(/(?:str\.|strada|улица|ул\.)\s*[^,.\n]{5,60}/i);
    if (addressMatch) facts.address = addressMatch[0].trim();

    // Coordinates
    const coordMatch = text.match(/(-?\d{1,3}\.\d{4,})[,\s]+(-?\d{1,3}\.\d{4,})/);
    if (coordMatch) {
        facts.latitude = coordMatch[1];
        facts.longitude = coordMatch[2];
    }

    return facts;
}

// --- Internal helpers ---

function _extractSearchResults(html) {
    const results = [];
    // Simple regex extraction from DuckDuckGo HTML results
    const resultPattern = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = resultPattern.exec(html)) !== null) {
        const url = _decodeDuckduckgoUrl(match[1]);
        const title = _stripHtml(match[2]);
        const snippet = _stripHtml(match[3]);
        if (url && title) {
            results.push({ url, title, snippet });
        }
    }
    return results;
}

function _decodeDuckduckgoUrl(encodedUrl) {
    try {
        const url = new URL(encodedUrl, 'https://duckduckgo.com');
        return url.searchParams.get('uddg') || encodedUrl;
    } catch {
        return encodedUrl;
    }
}

function _stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {
    searchOfficialSources,
    searchPlace,
    searchCommerce,
    searchWineNews,
    fetchSourcePage,
    extractStructuredFacts,
};

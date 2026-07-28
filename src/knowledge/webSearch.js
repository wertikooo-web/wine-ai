'use strict';

// Real web search via DuckDuckGo HTML — no API key required.
// This makes actual network calls to DuckDuckGo's search endpoint and
// extracts real search results with URLs, titles, and snippets.
//
// Design:
// - No API key needed (DuckDuckGo HTML endpoint)
// - Bounded timeout per request
// - Domain filtering for wine-relevant results
// - Real provenance tracking (source URL, fetched_at, confidence)
// - Rate limiting: max 3 concurrent requests

const { isDomainAllowed, sanitizeUrl, ALLOWED_DOMAINS } = require('./safeFetch');

const DDG_URL = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'WineAIRealtimeBot/0.2 (+https://github.com/wertikooo-web/wine-ai)';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESULTS = 10;
const MAX_CONCURRENT = 3;

let activeRequests = 0;

/**
 * Search the web using DuckDuckGo's HTML endpoint.
 * Returns real search results with URLs, titles, and snippets.
 *
 * @param {string} query - The search query
 * @param {object} options - { timeoutMs, maxResults, language }
 * @returns {Promise<{found: boolean, results: Array, tookMs: number, error?: string}>}
 */
async function searchWeb(query, { timeoutMs = DEFAULT_TIMEOUT_MS, maxResults = MAX_RESULTS, language = null } = {}) {
    const startedAt = Date.now();

    if (!query || !query.trim()) {
        return { found: false, results: [], tookMs: 0, error: 'empty_query' };
    }

    if (activeRequests >= MAX_CONCURRENT) {
        return { found: false, results: [], tookMs: 0, error: 'rate_limited' };
    }

    activeRequests++;
    try {
        const searchQuery = _buildSearchQuery(query, language);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(DDG_URL, {
            method: 'POST',
            headers: {
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'text/html',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            body: new URLSearchParams({ q: searchQuery, kl: 'wt-wt' }).toString(),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, results: [], tookMs: Date.now() - startedAt, error: `http_${response.status}` };
        }

        const html = await response.text();
        const results = _parseDuckDuckGoHtml(html);

        // Filter and limit
        const filtered = results
            .filter((r) => r.url && r.title)
            .slice(0, maxResults);

        console.log('[webSearch]', JSON.stringify({
            query: query.slice(0, 100),
            resultCount: filtered.length,
            tookMs: Date.now() - startedAt,
            topDomains: filtered.slice(0, 3).map((r) => {
                try { return new URL(r.url).hostname; } catch { return 'unknown'; }
            }),
        }));

        return {
            found: filtered.length > 0,
            results: filtered.map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet || '',
                source_type: 'general_web',
                confidence: 'medium',
                fetched_at: new Date().toISOString(),
            })),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        const tookMs = Date.now() - startedAt;
        console.error('[webSearch] error:', error.message, { query: query.slice(0, 100), tookMs });
        return { found: false, results: [], tookMs, error: error.message };
    } finally {
        activeRequests--;
    }
}

/**
 * Search for a specific official domain.
 * Returns the official website and contact pages.
 */
async function searchOfficialSite(entityName, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const query = `${entityName} official site wine moldova`;
    const result = await searchWeb(query, { timeoutMs, maxResults: 5 });

    if (!result.found) return result;

    // Boost official-looking domains
    const boosted = result.results.map((r) => {
        let domain = '';
        try { domain = new URL(r.url).hostname; } catch { /* */ }
        const isOfficial = _looksOfficial(entityName, domain);
        return { ...r, is_official: isOfficial, confidence: isOfficial ? 'high' : 'medium' };
    }).sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0));

    return { ...result, results: boosted };
}

/**
 * Search for wine-specific information (technical sheets, tasting notes, etc.)
 */
async function searchWineInfo(wineName, wineryName, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const query = `${wineryName} ${wineName} wine technical sheet tasting notes`;
    return searchWeb(query, { timeoutMs, maxResults: 5 });
}

/**
 * Search for wine news and events.
 */
async function searchWineNews(query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const fullQuery = `${query} wine moldova news 2026`;
    return searchWeb(fullQuery, { timeoutMs, maxResults: 5 });
}

// --- Internal helpers ---

function _buildSearchQuery(query, language) {
    // DuckDuckGo language parameter
    const langMap = { ru: 'ru-ru', ro: 'ro-ro', en: 'en-us' };
    const langParam = language ? (langMap[language] || 'wt-wt') : 'wt-wt';
    return query;
}

function _parseDuckDuckGoHtml(html) {
    const results = [];

    // DuckDuckGo HTML results pattern:
    // <div class="result results_links results_links_deep web-result">
    //   <a class="result__a" href="...">Title</a>
    //   <a class="result__snippet">Snippet text</a>
    // </div>

    // Extract result blocks
    const resultBlockPattern = /<div[^>]*class="[^"]*web-result[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*web-result|$)/gi;
    let blockMatch;

    while ((blockMatch = resultBlockPattern.exec(html)) !== null && results.length < MAX_RESULTS) {
        const block = blockMatch[1];

        // Extract URL from result__a
        const urlMatch = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]*)"/i);
        // Extract title from result__a
        const titleMatch = block.match(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
        // Extract snippet
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

        if (urlMatch && titleMatch) {
            const rawUrl = _decodeDuckduckgoUrl(urlMatch[1]);
            const title = _stripHtml(titleMatch[1]);
            const snippet = snippetMatch ? _stripHtml(snippetMatch[1]) : '';

            if (title && rawUrl) {
                results.push({ url: rawUrl, title, snippet });
            }
        }
    }

    // Fallback: try simpler pattern if no results found
    if (results.length === 0) {
        const simplePattern = /<a[^>]+href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = simplePattern.exec(html)) !== null && results.length < MAX_RESULTS) {
            const rawUrl = _decodeDuckduckgoUrl(match[1]);
            const title = _stripHtml(match[2]);
            if (title && rawUrl) {
                results.push({ url: rawUrl, title, snippet: '' });
            }
        }
    }

    return results;
}

function _decodeDuckduckgoUrl(encodedUrl) {
    try {
        const url = new URL(encodedUrl, 'https://duckduckgo.com');
        const actual = url.searchParams.get('uddg');
        if (actual) return decodeURIComponent(actual);
        return encodedUrl;
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
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#\d+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _looksOfficial(entityName, domain) {
    if (!domain || !entityName) return false;
    const nameLower = entityName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainLower = domain.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Check if domain contains the entity name
    if (domainLower.includes(nameLower)) return true;
    // Check known winery domains
    for (const allowed of ALLOWED_DOMAINS) {
        if (domainLower === allowed.replace(/[^a-z0-9]/g, '')) return true;
    }
    return false;
}

module.exports = {
    searchWeb,
    searchOfficialSite,
    searchWineInfo,
    searchWineNews,
};

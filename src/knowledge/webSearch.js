'use strict';

// Web search entry point for the knowledge router. Delegates to
// webSearchProvider.js (Gemini Grounding with Google Search by default,
// Brave as a secondary adapter behind the same interface). DuckDuckGo HTML
// scraping has been removed from the production path entirely -- confirmed
// via staging diagnostics that Railway's hosting IPs get an anti-bot
// challenge from DuckDuckGo (HTTP 202, no parseable results), which is not
// fixable from application code.
//
// Search itself is broad -- no domain allowlist at the search stage.
// Safety instead comes from classifySourceTrust() tagging each result
// official/reputable/general, used by the router to prioritize and by the
// answer policy to decide how confidently a source may be cited.

const { sanitizeUrl, classifySourceTrust } = require('./safeFetch');
const { search: providerSearch } = require('./webSearchProvider');

const MAX_RESULTS = 10;
const MAX_CONCURRENT = 3;

let activeRequests = 0;

/**
 * Search the web. Returns real search results with URLs, titles, snippets,
 * and a trust tier per result.
 *
 * @param {string} query - The search query
 * @param {object} options - { maxResults, language, sessionId, providerImpl }
 * @returns {Promise<{found: boolean, results: Array, provider: string, tookMs: number, error?: string}>}
 */
async function searchWeb(query, { maxResults = MAX_RESULTS, language = null, sessionId = null, providerImpl = providerSearch } = {}) {
    const startedAt = Date.now();

    if (!query || !query.trim()) {
        return { found: false, results: [], provider: null, tookMs: 0, error: 'empty_query' };
    }
    if (activeRequests >= MAX_CONCURRENT) {
        return { found: false, results: [], provider: null, tookMs: 0, error: 'rate_limited' };
    }

    activeRequests++;
    try {
        const outcome = await providerImpl(query, { count: maxResults, sessionId });

        const results = (outcome.results || [])
            .map((r) => {
                const cleanUrl = sanitizeUrl(r.url);
                if (!cleanUrl) return null;
                return {
                    title: r.title,
                    url: cleanUrl,
                    snippet: r.snippet || '',
                    source_trust: classifySourceTrust(cleanUrl),
                };
            })
            .filter(Boolean)
            .slice(0, maxResults);

        console.log('[webSearch]', JSON.stringify({
            query: query.slice(0, 100),
            provider: outcome.provider,
            rawResultCount: (outcome.results || []).length,
            resultCount: results.length,
            groundingQueries: outcome.groundingQueries || null,
            tookMs: Date.now() - startedAt,
            latencyMs: outcome.latencyMs ?? null,
            error: outcome.found ? null : outcome.error,
            topDomains: results.slice(0, 3).map((r) => {
                try { return new URL(r.url).hostname; } catch { return 'unknown'; }
            }),
        }));

        return {
            found: results.length > 0,
            results: results.map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.snippet,
                source_type: r.source_trust === 'official' ? 'official_winery' : r.source_trust === 'reputable' ? 'specialist_media' : 'general_web',
                confidence: r.source_trust === 'official' ? 'high' : r.source_trust === 'reputable' ? 'medium' : 'low',
                fetched_at: new Date().toISOString(),
            })),
            provider: outcome.provider,
            groundingQueries: outcome.groundingQueries || [],
            tookMs: Date.now() - startedAt,
            error: results.length === 0 ? outcome.error : null,
        };
    } finally {
        activeRequests--;
    }
}

/**
 * Search for a specific official domain. Returns the official website and
 * contact pages, boosting results that look like the entity's own site.
 */
async function searchOfficialSite(entityName, { sessionId = null } = {}) {
    const query = `${entityName} official site wine moldova`;
    const result = await searchWeb(query, { maxResults: 5, sessionId });
    if (!result.found) return result;

    const boosted = result.results.map((r) => {
        let domain = '';
        try { domain = new URL(r.url).hostname; } catch { /* */ }
        const isOfficial = _looksOfficial(entityName, domain) || r.source_type === 'official_winery';
        return { ...r, is_official: isOfficial, confidence: isOfficial ? 'high' : r.confidence };
    }).sort((a, b) => (b.is_official ? 1 : 0) - (a.is_official ? 1 : 0));

    return { ...result, results: boosted };
}

/**
 * Search for wine-specific information (technical sheets, tasting notes, etc.)
 */
async function searchWineInfo(wineName, wineryName, { sessionId = null } = {}) {
    const query = `${wineryName} ${wineName} wine technical sheet tasting notes`;
    return searchWeb(query, { maxResults: 5, sessionId });
}

function _looksOfficial(entityName, domain) {
    if (!domain || !entityName) return false;
    const nameLower = entityName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainLower = domain.toLowerCase().replace(/[^a-z0-9]/g, '');
    return domainLower.includes(nameLower);
}

module.exports = {
    searchWeb,
    searchOfficialSite,
    searchWineInfo,
};

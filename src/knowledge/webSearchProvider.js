'use strict';

// Production web search for WineAI. Primary provider is Gemini Grounding
// with Google Search: WineAI already calls Gemini elsewhere (no new vendor
// relationship), grounding returns real live search results WITH citations
// baked into the same call that can also draft the answer, and there is no
// HTML scraping to break.
//
// A second adapter (Brave Search API) is wired behind the same interface
// but not the default and needs no key configured -- available as a
// fallback if Gemini Grounding is ever unavailable, without new code.
//
// DuckDuckGo HTML scraping is REMOVED from the production path entirely
// (confirmed via staging diagnostics: Railway's hosting IPs get an anti-bot
// HTTP 202 from DuckDuckGo, never real results -- not fixable from here).

const db = require('./db');

const WEB_SEARCH_PROVIDER = process.env.WEB_SEARCH_PROVIDER || 'gemini-grounding'; // gemini-grounding | brave | disabled
const GROUNDING_MODEL = process.env.WEB_SEARCH_GROUNDING_MODEL || 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 8000);
const DAILY_QUERY_BUDGET = Number(process.env.WEB_SEARCH_DAILY_BUDGET || 500);
const SESSION_QUERY_BUDGET = Number(process.env.WEB_SEARCH_SESSION_BUDGET || 20);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h -- grounding facts don't churn
// fast enough to justify re-spending budget on a repeat question within a day.
const CACHE_MAX_ENTRIES = 1000;

// ---------------------------------------------------------------------
// Cost control: daily budget (Postgres-backed, file-fallback when no DB),
// per-session soft cap (in-memory, best-effort -- see note below), and a
// short in-memory result cache. Budget counts ACTUAL search queries
// performed, not calls to this module: Gemini Grounding may run several
// search queries to answer one question, and that is what has to be
// capped, not "one call = one query".
// ---------------------------------------------------------------------

let schemaReadyPromise = null;
function _ensureSchema() {
    if (!db.isEnabled()) return Promise.resolve(null);
    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            const pool = db.getPool();
            await pool.query(`
                CREATE TABLE IF NOT EXISTS web_search_usage (
                    day DATE PRIMARY KEY,
                    query_count INT NOT NULL DEFAULT 0,
                    request_count INT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            `);
            return pool;
        })();
    }
    return schemaReadyPromise;
}

// In-memory fallback counters, used when DATABASE_URL isn't set (local dev)
// or as the always-on per-session tracker (session budgets are intentionally
// not persisted -- they exist to stop one runaway conversation from burning
// the whole day's budget, not to survive a restart).
let memoryDay = null;
let memoryDayCount = 0;
const sessionCounts = new Map(); // sessionId -> { day, count }

function _todayUtc() {
    return new Date().toISOString().slice(0, 10);
}

async function _readDailyCount() {
    const today = _todayUtc();
    if (db.isEnabled()) {
        await _ensureSchema();
        const pool = db.getPool();
        const { rows } = await pool.query('SELECT query_count FROM web_search_usage WHERE day = $1', [today]);
        return rows[0] ? Number(rows[0].query_count) : 0;
    }
    if (memoryDay !== today) { memoryDay = today; memoryDayCount = 0; }
    return memoryDayCount;
}

async function _recordUsage(queryCount, sessionId) {
    const today = _todayUtc();
    if (db.isEnabled()) {
        await _ensureSchema();
        const pool = db.getPool();
        await pool.query(
            `INSERT INTO web_search_usage (day, query_count, request_count, updated_at)
             VALUES ($1, $2, 1, NOW())
             ON CONFLICT (day) DO UPDATE SET
                query_count = web_search_usage.query_count + EXCLUDED.query_count,
                request_count = web_search_usage.request_count + 1,
                updated_at = NOW()`,
            [today, queryCount]
        );
    } else {
        if (memoryDay !== today) { memoryDay = today; memoryDayCount = 0; }
        memoryDayCount += queryCount;
    }
    if (sessionId) {
        const entry = sessionCounts.get(sessionId);
        if (!entry || entry.day !== today) {
            sessionCounts.set(sessionId, { day: today, count: queryCount });
        } else {
            entry.count += queryCount;
        }
    }
}

function _sessionCount(sessionId) {
    if (!sessionId) return 0;
    const today = _todayUtc();
    const entry = sessionCounts.get(sessionId);
    if (!entry || entry.day !== today) return 0;
    return entry.count;
}

async function getBudgetStatus(sessionId) {
    const used = await _readDailyCount();
    return {
        used,
        limit: DAILY_QUERY_BUDGET,
        sessionUsed: _sessionCount(sessionId),
        sessionLimit: SESSION_QUERY_BUDGET,
        provider: WEB_SEARCH_PROVIDER,
    };
}

// Test-only reset -- production never calls this.
function _resetForTests() {
    memoryDay = null;
    memoryDayCount = 0;
    sessionCounts.clear();
    cache.clear();
    schemaReadyPromise = null;
}

// ---------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------

const cache = new Map();

function _cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { cache.delete(key); return null; }
    return entry.value;
}

function _cacheSet(key, value) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------
// Gemini Grounding with Google Search (primary provider)
// ---------------------------------------------------------------------

function _extractGroundingResult(response) {
    const candidate = response?.candidates?.[0];
    const metadata = candidate?.groundingMetadata;
    const answerText = typeof response?.text === 'string'
        ? response.text
        : candidate?.content?.parts?.map((part) => part.text || '').join('') || '';

    const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
    const results = chunks
        .map((chunk) => chunk?.web)
        .filter((web) => web?.uri)
        .map((web) => ({
            title: web.title || web.uri,
            url: web.uri,
            snippet: answerText.slice(0, 300), // grounding chunks don't carry
            // their own snippet text -- the model's grounded answer is the
            // best available summary of what that source contributed.
        }));

    const searchQueries = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries : [];
    return { results, searchQueries, answerText };
}

async function geminiGroundingSearch(query, {
    apiKey = process.env.GEMINI_API_KEY || '',
    model = GROUNDING_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    generateContent,
    sessionId = null,
} = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return { found: false, results: [], provider: 'gemini-grounding', error: 'empty_query' };

    const dailyUsed = await _readDailyCount();
    if (dailyUsed >= DAILY_QUERY_BUDGET) {
        return { found: false, results: [], provider: 'gemini-grounding', error: 'daily_budget_exceeded' };
    }
    if (sessionId && _sessionCount(sessionId) >= SESSION_QUERY_BUDGET) {
        return { found: false, results: [], provider: 'gemini-grounding', error: 'session_budget_exceeded' };
    }

    const cacheKey = normalizedQuery.toLowerCase();
    const cached = _cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };

    if (!apiKey && typeof generateContent !== 'function') {
        return { found: false, results: [], provider: 'gemini-grounding', error: 'no_api_key' };
    }

    const startedAt = Date.now();
    let response;
    try {
        if (typeof generateContent === 'function') {
            response = await generateContent({ model, query: normalizedQuery });
        } else {
            const { GoogleGenAI } = require('@google/genai');
            const ai = new GoogleGenAI({ apiKey });
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                response = await ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts: [{ text: normalizedQuery }] }],
                    config: { tools: [{ googleSearch: {} }] },
                });
            } finally {
                clearTimeout(timeout);
            }
        }
    } catch (error) {
        return { found: false, results: [], provider: 'gemini-grounding', error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'unknown_error') };
    }

    const { results, searchQueries, answerText } = _extractGroundingResult(response);
    const queryCount = Math.max(1, searchQueries.length); // Gemini decides
    // internally how many searches to run for one call -- record the real
    // count so the budget reflects actual usage, defaulting to 1 if the SDK
    // didn't report queries (still grounded, just not itemized).
    await _recordUsage(queryCount, sessionId);

    const value = {
        found: results.length > 0,
        results,
        provider: 'gemini-grounding',
        groundingQueries: searchQueries,
        groundedAnswer: answerText || null,
        latencyMs: Date.now() - startedAt,
        cached: false,
    };
    if (results.length > 0) _cacheSet(cacheKey, value);
    return value;
}

// ---------------------------------------------------------------------
// Brave Search API (secondary adapter, same interface -- no key required
// to be configured; simply returns no_api_key/found:false until one is).
// ---------------------------------------------------------------------

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

async function braveSearch(query, {
    apiKey = process.env.BRAVE_SEARCH_API_KEY || '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    count = 6,
    fetchImpl = fetch,
    sessionId = null,
} = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return { found: false, results: [], provider: 'brave', error: 'empty_query' };
    if (!apiKey) return { found: false, results: [], provider: 'brave', error: 'no_api_key' };

    const dailyUsed = await _readDailyCount();
    if (dailyUsed >= DAILY_QUERY_BUDGET) return { found: false, results: [], provider: 'brave', error: 'daily_budget_exceeded' };

    const cacheKey = `brave::${normalizedQuery.toLowerCase()}`;
    const cached = _cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const url = new URL(BRAVE_ENDPOINT);
        url.searchParams.set('q', normalizedQuery);
        url.searchParams.set('count', String(count));
        const response = await fetchImpl(url.toString(), {
            headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
            signal: controller.signal,
        });
        await _recordUsage(1, sessionId);
        if (!response.ok) return { found: false, results: [], provider: 'brave', error: `http_${response.status}` };

        const data = await response.json();
        const results = (Array.isArray(data?.web?.results) ? data.web.results : [])
            .filter((r) => r?.url && r?.title)
            .map((r) => ({ title: String(r.title), url: String(r.url), snippet: String(r.description || '') }));

        const value = { found: results.length > 0, results, provider: 'brave', cached: false };
        if (results.length > 0) _cacheSet(cacheKey, value);
        return value;
    } catch (error) {
        return { found: false, results: [], provider: 'brave', error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'unknown_error') };
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

async function search(query, options = {}) {
    const provider = options.provider || WEB_SEARCH_PROVIDER;
    if (provider === 'disabled') return { found: false, results: [], provider: 'disabled', error: 'provider_disabled' };
    if (provider === 'brave') return braveSearch(query, options);
    return geminiGroundingSearch(query, options);
}

module.exports = {
    search,
    geminiGroundingSearch,
    braveSearch,
    getBudgetStatus,
    DAILY_QUERY_BUDGET,
    SESSION_QUERY_BUDGET,
    WEB_SEARCH_PROVIDER,
    _resetForTests,
};

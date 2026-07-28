'use strict';

// Real place/location search via OpenStreetMap Nominatim — no API key needed.
// Provides address, coordinates, opening hours, and official website for
// physical locations (wineries, wine shops, restaurants, tourism spots).
//
// This makes actual network calls to Nominatim's search API.
// Nominatim usage policy: max 1 request/second, include valid User-Agent.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'WineAIRealtimeBot/0.2 (wine-ai-realtime project)';
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;

// Request rate limiter (1 req/sec per Nominatim policy)
let lastRequestTime = 0;
const MIN_INTERVAL_MS = 1100;

async function _rateLimitedFetch(url, options) {
    const now = Date.now();
    const wait = MIN_INTERVAL_MS - (now - lastRequestTime);
    if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestTime = Date.now();
    return fetch(url, options);
}

/**
 * Search for a place by name, returning address, coordinates, and metadata.
 *
 * @param {string} entityName - The place name (e.g. "WineMD", "Purcari winery")
 * @param {object} options - { city, country, timeoutMs, maxResults }
 * @returns {Promise<{found: boolean, places: Array, tookMs: number, error?: string}>}
 */
async function searchPlace(entityName, { city = null, country = null, timeoutMs = DEFAULT_TIMEOUT_MS, maxResults = MAX_RESULTS } = {}) {
    const startedAt = Date.now();

    if (!entityName || !entityName.trim()) {
        return { found: false, places: [], tookMs: 0, error: 'empty_query' };
    }

    try {
        // Build query with optional city/country context
        let query = entityName.trim();
        if (city) query += `, ${city}`;
        if (country) query += `, ${country}`;
        else query += ', Moldova'; // Default to Moldova

        const params = new URLSearchParams({
            format: 'json',
            q: query,
            limit: String(maxResults),
            addressdetails: '1',
            extratags: '1',
            namedetails: '1',
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await _rateLimitedFetch(`${NOMINATIM_URL}?${params.toString()}`, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, places: [], tookMs: Date.now() - startedAt, error: `http_${response.status}` };
        }

        const data = await response.json();

        if (!Array.isArray(data) || data.length === 0) {
            return { found: false, places: [], tookMs: Date.now() - startedAt };
        }

        const places = data.map((place) => _normalizeNominatimResult(place));

        console.log('[placeSearch]', JSON.stringify({
            query: query.slice(0, 100),
            resultCount: places.length,
            tookMs: Date.now() - startedAt,
            topResult: places[0]?.name || null,
        }));

        return {
            found: true,
            places,
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        const tookMs = Date.now() - startedAt;
        console.error('[placeSearch] error:', error.message, { entityName, tookMs });
        return { found: false, places: [], tookMs, error: error.message };
    }
}

/**
 * Reverse geocode: get address from coordinates.
 */
async function reverseGeocode(lat, lon, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();

    try {
        const params = new URLSearchParams({
            format: 'json',
            lat: String(lat),
            lon: String(lon),
            addressdetails: '1',
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await _rateLimitedFetch(`${NOMINATIM_URL}?${params.toString()}`, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            return { found: false, place: null, tookMs: Date.now() - startedAt, error: `http_${response.status}` };
        }

        const data = await response.json();
        if (!data || !data.display_name) {
            return { found: false, place: null, tookMs: Date.now() - startedAt };
        }

        return {
            found: true,
            place: _normalizeNominatimResult(data),
            tookMs: Date.now() - startedAt,
        };
    } catch (error) {
        return { found: false, place: null, tookMs: Date.now() - startedAt, error: error.message };
    }
}

/**
 * Get opening hours for a place from Nominatim extratags.
 */
function extractOpeningHours(nominatimPlace) {
    if (!nominatimPlace) return null;
    // Nominatim returns opening_hours in extratags
    const raw = nominatimPlace.extratags?.opening_hours ||
                nominatimPlace.opening_hours ||
                null;
    return raw || null;
}

// --- Internal helpers ---

function _normalizeNominatimResult(place) {
    const addr = place.address || {};
    const extratags = place.extratags || {};
    const namedetails = place.namedetails || {};

    // Build structured address
    const addressParts = [];
    if (addr.road) addressParts.push(addr.road);
    if (addr.house_number) addressParts.push(addr.house_number);
    if (addr.city || addr.town || addr.village) addressParts.push(addr.city || addr.town || addr.village);
    if (addr.state) addressParts.push(addr.state);
    if (addr.country) addressParts.push(addr.country);

    return {
        name: namedetails.name || place.display_name?.split(',')[0] || 'Unknown',
        canonical_name: namedetails.name || namedetails.short_name || place.display_name?.split(',')[0],
        display_name: place.display_name,
        formatted_address: addressParts.join(', ') || place.display_name,
        latitude: place.lat,
        longitude: place.lon,
        osm_id: place.osm_id,
        osm_type: place.osm_type,
        category: place.class,
        type: place.type,
        importance: place.importance,
        // Structured address components
        address: {
            road: addr.road || null,
            house_number: addr.house_number || null,
            city: addr.city || addr.town || addr.village || null,
            state: addr.state || null,
            country: addr.country || null,
            country_code: addr.country_code || null,
            postcode: addr.postcode || null,
        },
        // Extra tags (opening_hours, website, phone, etc.)
        website: extratags.website || extratags.contact_website || null,
        phone: extratags.phone || extratags.contact_phone || null,
        opening_hours: extratags.opening_hours || null,
        // Source attribution
        source_type: 'maps_place_provider',
        confidence: 'medium',
        fetched_at: new Date().toISOString(),
    };
}

module.exports = {
    searchPlace,
    reverseGeocode,
    extractOpeningHours,
};

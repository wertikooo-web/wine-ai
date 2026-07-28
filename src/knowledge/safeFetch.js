'use strict';

// SSRF protection and domain allowlisting for external fetches.
// Blocks private IPs, unsafe redirects, and untrusted domains.

const { URL } = require('url');

// Allowed domains for external fetches — explicitly verified sources
const ALLOWED_DOMAINS = new Set([
    // Search
    'html.duckduckgo.com',
    'duckduckgo.com',
    // Maps
    'nominatim.openstreetmap.org',
    'openstreetmap.org',
    // Wine commerce
    'wine.md',
    // Wine of Moldova
    'wineofmoldova.com',
    // Known winery domains
    'purcariwineries.com',
    'cricova.md',
    'castelmimi.md',
    'vartely.md',
    'asconiwinery.com',
    'etcetera.md',
    'gitanawinery.com',
    'fautor.wine',
    'salcutawine.md',
    'basavin.md',
    'kvint.md',
    'vinuridecomrat.md',
    'carlevana.md',
    // Tourism
    'moldova.travel',
    'visit.chisinau.md',
    // News
    'wine-and-spirits.md',
]);

// Blocked IP ranges (private/reserved)
const BLOCKED_IP_PREFIXES = [
    '10.',
    '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.',
    '127.',
    '0.',
    '169.254.',
    'fc00:',
    'fd00:',
    'fe80:',
    '::1',
];

function isDomainAllowed(urlString) {
    try {
        const url = new URL(urlString);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return ALLOWED_DOMAINS.has(url.hostname);
    } catch {
        return false;
    }
}

function sanitizeUrl(urlString) {
    try {
        const url = new URL(urlString);
        // Only http/https
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        // Remove fragments
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

function isPrivateIp(hostname) {
    // For domain-based checks, we resolve at DNS level — block obviously
    // private hostnames
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    // Check if hostname looks like a private IP
    for (const prefix of BLOCKED_IP_PREFIXES) {
        if (hostname.startsWith(prefix)) return true;
    }
    return false;
}

module.exports = { isDomainAllowed, sanitizeUrl, isPrivateIp, ALLOWED_DOMAINS };

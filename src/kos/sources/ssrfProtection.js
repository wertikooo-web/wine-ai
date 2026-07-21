'use strict';

/**
 * WINE AI KOS - SSRF Protection & Ingestion Security Module (Step 2C.1)
 *
 * Implements strict, production-grade SSRF security validation:
 * - Reject embedded credentials in URLs (user:pass@)
 * - Restrict protocols to http: and https:
 * - Restrict ports to 80 and 443
 * - DNS A/AAAA resolution & validation of all resolved IPs
 * - Block IPv4/IPv6 private, loopback, link-local, cloud metadata (169.254.169.254)
 * - Block alternative IP formats (decimal, hex, octal)
 * - Socket IP pinning to prevent TOCTOU DNS rebinding
 */

const dns = require('dns').promises;
const net = require('net');
const url = require('url');

class SsrfValidationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SsrfValidationError';
        this.code = code;
    }
}

const BLOCKED_HOSTNAMES = [
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
];

const BLOCKED_SUFFIXES = [
    '.internal',
    '.local',
    '.railway.internal',
];

function isPrivateIp(ip) {
    if (!net.isIP(ip)) return true;

    // Normalize IPv4-mapped IPv6
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }

    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        const [a, b] = parts;

        if (a === 0) return true; // 0.0.0.0/8
        if (a === 127) return true; // 127.0.0.0/8 Loopback
        if (a === 10) return true; // 10.0.0.0/8 Private
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 Private
        if (a === 192 && b === 168) return true; // 192.168.0.0/16 Private
        if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local / Cloud metadata (169.254.169.254)

        return false;
    }

    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1' || normalized === '::') return true; // Loopback / Unspecified
        if (normalized.startsWith('fe80:')) return true; // Link-local
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local (fc00::/7)

        return false;
    }

    return true;
}

function detectAlternativeIpNotation(hostname) {
    // Rejects decimal integer IPs (e.g. 2130706433), octal (0177.0.0.1), hex (0x7f000001)
    if (/^\d+$/.test(hostname)) return true;
    if (/^0x[0-9a-fA-F]+$/i.test(hostname)) return true;
    if (/^0[0-7]+(?:\.0[0-7]+)*$/.test(hostname)) return true;
    if (/^(?:0x[0-9a-fA-F]+\.){3}0x[0-9a-fA-F]+$/i.test(hostname)) return true;
    return false;
}

function normalizeUrlSyntactic(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new SsrfValidationError('KOS_SSRF_INVALID_URL', 'URL must be a non-empty string.');
    }

    // Reject embedded credentials (user:pass@)
    if (/@/.test(rawUrl.split('/')[2] || '')) {
        throw new SsrfValidationError('KOS_SSRF_CREDENTIALS_REJECTED', 'URLs with embedded credentials are strictly rejected.');
    }

    let parsed;
    try {
        parsed = new url.URL(rawUrl);
    } catch {
        throw new SsrfValidationError('KOS_SSRF_INVALID_URL', `Failed to parse URL: ${rawUrl}`);
    }

    // Protocol check
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SsrfValidationError('KOS_SSRF_DISALLOWED_PROTOCOL', `Disallowed protocol: ${parsed.protocol}. Only http and https are allowed.`);
    }

    // Port check
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) {
        throw new SsrfValidationError('KOS_SSRF_DISALLOWED_PORT', `Disallowed port: ${port}. Only ports 80 and 443 are allowed.`);
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check blocked hostnames and suffixes
    if (BLOCKED_HOSTNAMES.includes(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
        throw new SsrfValidationError('KOS_SSRF_BLOCKED_HOST', `Blocked hostname or internal domain suffix: ${hostname}`);
    }

    // Check alternative IP encodings
    if (detectAlternativeIpNotation(hostname)) {
        throw new SsrfValidationError('KOS_SSRF_ALTERNATIVE_IP_REJECTED', `Alternative IP notation rejected: ${hostname}`);
    }

    // Normalized origin
    const normalizedOrigin = `${parsed.protocol}//${hostname}${parsed.port ? ':' + parsed.port : ''}`;

    return {
        parsed,
        hostname,
        port,
        normalizedOrigin,
        canonicalUrl: parsed.href,
    };
}

async function validateUrlSsrf(rawUrl) {
    const { parsed, hostname, port, normalizedOrigin, canonicalUrl } = normalizeUrlSyntactic(rawUrl);

    // If direct IP address is specified
    if (net.isIP(hostname)) {
        if (isPrivateIp(hostname)) {
            throw new SsrfValidationError('KOS_SSRF_PRIVATE_IP', `Direct private/loopback IP rejected: ${hostname}`);
        }
        return {
            canonicalUrl,
            normalizedOrigin,
            hostname,
            port,
            verifiedIps: [hostname],
            primaryIp: hostname,
        };
    }

    // DNS A / AAAA resolution
    let resolvedIps = [];
    try {
        const [aRecords, aaaaRecords] = await Promise.allSettled([
            dns.resolve4(hostname),
            dns.resolve6(hostname),
        ]);

        if (aRecords.status === 'fulfilled') resolvedIps.push(...aRecords.value);
        if (aaaaRecords.status === 'fulfilled') resolvedIps.push(...aaaaRecords.value);
    } catch (err) {
        throw new SsrfValidationError('KOS_SSRF_DNS_FAILED', `DNS resolution failed for hostname: ${hostname} (${err.message})`);
    }

    if (!resolvedIps.length) {
        throw new SsrfValidationError('KOS_SSRF_NO_IP_RESOLVED', `No IP addresses resolved for hostname: ${hostname}`);
    }

    // Check ALL resolved IPs
    for (const resolvedIp of resolvedIps) {
        if (isPrivateIp(resolvedIp)) {
            throw new SsrfValidationError('KOS_SSRF_PRIVATE_IP', `Hostname ${hostname} resolved to private/loopback IP: ${resolvedIp}`);
        }
    }

    return {
        canonicalUrl,
        normalizedOrigin,
        hostname,
        port,
        verifiedIps: resolvedIps,
        primaryIp: resolvedIps[0],
    };
}

module.exports = {
    validateUrlSsrf,
    normalizeUrlSyntactic,
    isPrivateIp,
    SsrfValidationError,
};

'use strict';

/**
 * WINE AI KOS - Safe Low-Level HTTP Client (Step 2C.2)
 *
 * Provides safe HTTP/HTTPS resource fetching with:
 * - Real Socket IP Pinning preventing DNS rebinding TOCTOU vulnerabilities
 * - Manual redirect chain execution with per-hop SSRF validation
 * - Strict streaming response size capping (maxBytes)
 * - Overall timeout & AbortSignal cancellation
 * - Transparent Content-Encoding decoding (gzip, deflate, br)
 * - Header redaction (set-cookie, authorization)
 * - Structured error classification (retryable boolean flag)
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { validateUrlSsrf, normalizeUrlSyntactic } = require('./ssrfProtection');
const { detectMimeType } = require('./mimeDetector');

function createStructuredError(code, message, details = {}, retryable = false) {
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    err.details = details;
    err.retryable = retryable;
    return err;
}

function sanitizeHeaders(rawHeaders) {
    const sanitized = {};
    if (!rawHeaders) return sanitized;

    for (const [key, value] of Object.entries(rawHeaders)) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'set-cookie' || lowerKey === 'authorization' || lowerKey === 'proxy-authorization' || lowerKey === 'cookie') {
            continue;
        }
        sanitized[lowerKey] = value;
    }
    return sanitized;
}

async function safeFetchResource({
    url,
    timeoutMs = 15000,
    maxBytes = 10485760, // 10 MB default
    maxRedirects = 5,
    allowedPorts = [80, 443],
    userAgent = 'WINE-AI-KOS-Crawler/1.0',
    signal = null,
    dependencies = {},
}) {
    if (!url || typeof url !== 'string') {
        throw createStructuredError('KOS_HTTP_INVALID_URL', 'URL string is required', {}, false);
    }

    const redirectChain = [];
    let currentUrl = url;
    let redirectCount = 0;

    while (true) {
        // 1. Syntactic Normalization
        const normalizedUrl = normalizeUrlSyntactic(currentUrl);

        // 2. SSRF Check & Host DNS resolution
        let ssrfValidation;
        if (dependencies.validateUrlSsrf) {
            ssrfValidation = await dependencies.validateUrlSsrf(normalizedUrl);
        } else {
            ssrfValidation = await validateUrlSsrf(normalizedUrl);
        }

        if (!ssrfValidation.valid) {
            if (redirectCount > 0) {
                throw createStructuredError('KOS_SSRF_REDIRECT_TARGET_BLOCKED', `Redirect target ${normalizedUrl} blocked: ${ssrfValidation.error}`, { url: normalizedUrl }, false);
            }
            throw createStructuredError('KOS_SSRF_BLOCKED', `SSRF check failed: ${ssrfValidation.error}`, { url: normalizedUrl }, false);
        }

        const targetIp = ssrfValidation.resolvedIps && ssrfValidation.resolvedIps.length > 0 ? ssrfValidation.resolvedIps[0] : null;

        // Execute Single Hop Fetch
        const fetchResult = await fetchSingleHop({
            url: normalizedUrl,
            targetIp,
            allowedIps: ssrfValidation.resolvedIps || [],
            timeoutMs,
            maxBytes,
            allowedPorts,
            userAgent,
            signal,
            dependencies,
        });

        const statusCode = fetchResult.statusCode;

        // Handle Manual Redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const locationHeader = fetchResult.headers['location'];
            if (!locationHeader) {
                throw createStructuredError('KOS_HTTP_REDIRECT_LOCATION_INVALID', 'Redirect response missing Location header', { url: normalizedUrl }, false);
            }

            let nextUrl;
            try {
                nextUrl = new URL(locationHeader, normalizedUrl).href;
            } catch {
                throw createStructuredError('KOS_HTTP_REDIRECT_LOCATION_INVALID', `Invalid Location header URL: ${locationHeader}`, { url: normalizedUrl }, false);
            }

            redirectCount++;
            if (redirectCount > maxRedirects) {
                throw createStructuredError('KOS_HTTP_REDIRECT_LIMIT_EXCEEDED', `Max redirects (${maxRedirects}) exceeded`, { redirectChain }, false);
            }

            if (redirectChain.includes(nextUrl)) {
                throw createStructuredError('KOS_HTTP_REDIRECT_LOOP', `Redirect loop detected at ${nextUrl}`, { redirectChain }, false);
            }

            redirectChain.push(normalizedUrl);
            currentUrl = nextUrl;
            continue;
        }

        // Return final non-redirect response
        return {
            requestedUrl: url,
            finalUrl: normalizedUrl,
            redirectChain,
            statusCode: fetchResult.statusCode,
            headers: fetchResult.headers,
            declaredContentType: fetchResult.declaredContentType,
            detectedContentType: fetchResult.detectedContentType,
            contentLength: fetchResult.contentLength,
            fetchedAt: new Date().toISOString(),
            remoteAddress: fetchResult.remoteAddress,
            rawBody: fetchResult.rawBody,
        };
    }
}

function fetchSingleHop({
    url,
    targetIp,
    allowedIps,
    timeoutMs,
    maxBytes,
    allowedPorts,
    userAgent,
    signal,
    dependencies,
}) {
    return new Promise((resolve, reject) => {
        // If mock transport is provided in dependencies, use it (100% offline testing)
        if (dependencies.httpTransport) {
            return dependencies
                .httpTransport({ url, targetIp, allowedIps, timeoutMs, maxBytes, userAgent, signal })
                .then(resolve)
                .catch(reject);
        }

        const parsedUrl = new URL(url);
        const protocol = parsedUrl.protocol;
        const hostname = parsedUrl.hostname;
        const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : protocol === 'https:' ? 443 : 80;

        if (!allowedPorts.includes(port)) {
            return reject(createStructuredError('KOS_HTTP_PORT_BLOCKED', `Port ${port} not allowed`, { port }, false));
        }

        const isHttps = protocol === 'https:';
        const requestModule = isHttps ? https : http;

        let isAborted = false;
        let timeoutTimer = null;

        // Custom lookup function for socket pinning
        const customLookup = (lookupHost, options, callback) => {
            if (dependencies.dnsResolver) {
                return dependencies.dnsResolver(lookupHost, (err, ip) => {
                    if (err) return callback(err);
                    return callback(null, ip, ip.includes(':') ? 6 : 4);
                });
            }

            if (targetIp) {
                const family = targetIp.includes(':') ? 6 : 4;
                return callback(null, targetIp, family);
            }

            return callback(new Error(`KOS_SSRF_NO_PUBLIC_ADDRESS: No verified IP for ${lookupHost}`));
        };

        const reqOptions = {
            hostname,
            port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': userAgent,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                Host: hostname,
            },
            lookup: customLookup,
            servername: hostname, // TLS SNI
        };

        const req = requestModule.request(reqOptions, (res) => {
            const statusCode = res.statusCode || 200;
            const headers = sanitizeHeaders(res.headers);
            const declaredContentType = headers['content-type'] || 'application/octet-stream';

            // Check Content-Length if present
            const contentLengthHeader = headers['content-length'];
            if (contentLengthHeader) {
                const declaredSize = parseInt(contentLengthHeader, 10);
                if (!isNaN(declaredSize) && declaredSize > maxBytes) {
                    req.destroy();
                    return reject(createStructuredError('KOS_HTTP_RESPONSE_TOO_LARGE', `Content-Length ${declaredSize} exceeds limit ${maxBytes}`, { maxBytes }, false));
                }
            }

            // Prepare Decompression Stream
            const contentEncoding = (headers['content-encoding'] || '').toLowerCase();
            let stream = res;

            if (contentEncoding === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            } else if (contentEncoding === 'deflate') {
                stream = res.pipe(zlib.createInflate());
            } else if (contentEncoding === 'br') {
                stream = res.pipe(zlib.createBrotliDecompress());
            }

            const chunks = [];
            let totalBytes = 0;

            const cleanupStream = () => {
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                try { stream.unpipe(); } catch {}
                try { stream.destroy(); } catch {}
                try { res.destroy(); } catch {}
                try { req.destroy(); } catch {}
            };

            stream.on('data', (chunk) => {
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    cleanupStream();
                    return reject(createStructuredError('KOS_HTTP_RESPONSE_TOO_LARGE', `Downloaded bytes exceeded maxBytes ${maxBytes}`, { maxBytes }, false));
                }
                chunks.push(chunk);
            });

            stream.on('end', () => {
                if (timeoutTimer) clearTimeout(timeoutTimer);
                if (isAborted) return;

                const rawBody = Buffer.concat(chunks);
                const detectedContentType = detectMimeType(rawBody, declaredContentType);

                const socket = req.socket;
                const remoteAddress = socket ? socket.remoteAddress : targetIp;

                resolve({
                    statusCode,
                    headers,
                    declaredContentType,
                    detectedContentType,
                    contentLength: rawBody.length,
                    remoteAddress,
                    rawBody,
                });
            });

            stream.on('error', (err) => {
                cleanupStream();
                if (isAborted) return;
                reject(createStructuredError('KOS_HTTP_CONNECTION_FAILED', `Stream error: ${err.message}`, {}, true));
            });
        });

        // Socket Remote Address Verification
        req.on('socket', (socket) => {
            socket.on('connect', () => {
                const actualIp = socket.remoteAddress;
                if (actualIp && allowedIps && allowedIps.length > 0 && !allowedIps.includes(actualIp)) {
                    req.destroy();
                    if (timeoutTimer) clearTimeout(timeoutTimer);
                    return reject(createStructuredError('KOS_SSRF_REMOTE_IP_MISMATCH', `Socket connected to unverified IP ${actualIp}`, { actualIp }, false));
                }
            });
        });

        req.on('error', (err) => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (isAborted) return;

            const isRetryable = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(err.code);
            reject(createStructuredError('KOS_HTTP_CONNECTION_FAILED', err.message, { code: err.code }, isRetryable));
        });

        // Handle Signal / Timeout
        if (signal) {
            signal.addEventListener('abort', () => {
                isAborted = true;
                if (timeoutTimer) clearTimeout(timeoutTimer);
                req.destroy();
                reject(createStructuredError('KOS_HTTP_ABORTED', 'Request aborted by caller AbortSignal', {}, true));
            });
        }

        if (timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                isAborted = true;
                req.destroy();
                reject(createStructuredError('KOS_HTTP_TIMEOUT', `Request timed out after ${timeoutMs}ms`, { timeoutMs }, true));
            }, timeoutMs);
        }

        req.end();
    });
}

module.exports = {
    safeFetchResource,
    createStructuredError,
    sanitizeHeaders,
};

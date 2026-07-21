'use strict';

/**
 * WINE AI KOS - HTML Link Extractor Module (Step 2C.2)
 *
 * Extracts document URLs from HTML markup:
 * - Extracts `href` attributes from `a` and `link` tags
 * - Resolves relative URLs to absolute URLs against `baseUrl`
 * - Strips fragments `#`
 * - Ignores non-document schemes (`mailto:`, `tel:`, `javascript:`, `data:`, `blob:`, `ftp:`, `file:`)
 * - Ignores static asset extensions (`.png`, `.jpg`, `.css`, `.js`, `.woff`, `.mp4`, etc.)
 */

const cheerio = require('cheerio');
const { normalizeUrlSyntactic } = require('./ssrfProtection');

const DISALLOWED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.css', '.js', '.mjs',
    '.woff', '.woff2', '.ttf', '.eot',
    '.mp3', '.mp4', '.avi', '.mov', '.webm',
    '.zip', '.tar', '.gz', '.7z'
]);

function extractHtmlLinks(htmlContent, baseUrl) {
    if (!htmlContent || typeof htmlContent !== 'string') {
        return [];
    }

    const $ = cheerio.load(htmlContent);
    const discoveredUrls = new Set();

    $('a[href], link[href]').each((_, el) => {
        const rawHref = $(el).attr('href');
        if (!rawHref || typeof rawHref !== 'string') return;

        const trimmed = rawHref.trim();
        if (
            trimmed.startsWith('mailto:') ||
            trimmed.startsWith('tel:') ||
            trimmed.startsWith('javascript:') ||
            trimmed.startsWith('data:') ||
            trimmed.startsWith('blob:') ||
            trimmed.startsWith('ftp:') ||
            trimmed.startsWith('file:')
        ) {
            return;
        }

        try {
            const absolute = new URL(trimmed, baseUrl).href;
            // Strip fragment
            const parsed = new URL(absolute);
            parsed.hash = '';

            // Check extension
            const pathname = parsed.pathname.toLowerCase();
            const extIdx = pathname.lastIndexOf('.');
            if (extIdx !== -1) {
                const ext = pathname.slice(extIdx);
                if (DISALLOWED_EXTENSIONS.has(ext)) {
                    return;
                }
            }

            const normalized = normalizeUrlSyntactic(parsed.href);
            discoveredUrls.add(normalized);
        } catch {
            /* Ignore invalid URLs */
        }
    });

    return Array.from(discoveredUrls);
}

module.exports = {
    extractHtmlLinks,
};

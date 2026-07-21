'use strict';

/**
 * WINE AI KOS - Robots.txt Policy Parser & Enforcement Module (Step 2C.2)
 *
 * Implements robots.txt parsing and URL permission checks for crawler.
 */

function parseRobotsTxt(robotsText, targetUserAgent = 'WINE-AI-KOS-Crawler/1.0') {
    const rules = [];
    const sitemaps = [];

    if (!robotsText || typeof robotsText !== 'string') {
        return { isAllowed: () => true, sitemaps: [] };
    }

    const lines = robotsText.split(/\r?\n/);
    let currentUserAgents = [];
    let isMatchingAgent = false;

    for (let line of lines) {
        // Strip comments
        const commentIdx = line.indexOf('#');
        if (commentIdx !== -1) {
            line = line.substring(0, commentIdx);
        }
        line = line.trim();
        if (!line) continue;

        const parts = line.split(':');
        if (parts.length < 2) continue;

        const directive = parts[0].trim().toLowerCase();
        const value = parts.slice(1).join(':').trim();

        if (directive === 'user-agent') {
            const agent = value.toLowerCase();
            if (currentUserAgents.length > 0 && rules.length > 0 && isMatchingAgent) {
                // Keep matching agent rules
            }
            currentUserAgents = [agent];
            isMatchingAgent = agent === '*' || targetUserAgent.toLowerCase().includes(agent);
        } else if (directive === 'disallow' && isMatchingAgent) {
            if (value) {
                rules.push({ type: 'disallow', path: value });
            }
        } else if (directive === 'allow' && isMatchingAgent) {
            if (value) {
                rules.push({ type: 'allow', path: value });
            }
        } else if (directive === 'sitemap') {
            if (value && (value.startsWith('http://') || value.startsWith('https://'))) {
                sitemaps.push(value);
            }
        }
    }

    function isAllowed(urlPath) {
        if (!urlPath) return true;
        let allowed = true;
        let matchedLength = -1;

        for (const rule of rules) {
            if (urlPath.startsWith(rule.path)) {
                if (rule.path.length > matchedLength) {
                    matchedLength = rule.path.length;
                    allowed = rule.type === 'allow';
                }
            }
        }

        return allowed;
    }

    return {
        isAllowed,
        sitemaps,
    };
}

module.exports = {
    parseRobotsTxt,
};

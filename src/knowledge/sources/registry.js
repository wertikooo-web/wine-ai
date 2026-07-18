'use strict';

// Source registry — see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.8. Every
// URL here was verified to actually exist (see the browser-verification
// note in the architecture doc) before being added — never guess a URL and
// hardcode it as a trusted source.
//
// Individual winery domains (Purcari, Cricova, Castel Mimi, ...) are
// intentionally NOT included yet — each one needs the same verification
// step before being added. wineofmoldova.com already aggregates winery,
// region, tourism, and news content under the official ONVV brand, which
// is enough for an honest v1.

const TRUST_LEVELS = ['A', 'B', 'C', 'D'];

const SOURCES = [
    {
        id: 'onvv-official',
        type: 'official',
        trust: 'A',
        publisher: 'Wine of Moldova (ONVV)',
        // Every URL below was confirmed to exist by actually navigating the
        // site's own nav links (browser tool), not guessed — see
        // docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.8.
        pages: [
            { url: 'https://wineofmoldova.com/en/about-onvv/', language: 'en', topics: ['onvv'] },
            { url: 'https://wineofmoldova.com/en/our-wineries/', language: 'en', topics: ['winery'] },
            { url: 'https://wineofmoldova.com/en/wine-tourism/', language: 'en', topics: ['tourism'] },
            { url: 'https://wineofmoldova.com/en/moldovan-wine/', language: 'en', topics: ['grape', 'wine'] },
            { url: 'https://wineofmoldova.com/en/wine-regions/', language: 'en', topics: ['region'] },
            { url: 'https://wineofmoldova.com/en/news-and-media/', language: 'en', topics: ['news'] },
            { url: 'https://wineofmoldova.com/ro/despre-onvv/', language: 'ro', topics: ['onvv'] },
            { url: 'https://wineofmoldova.com/ro/vinariile-noastre/', language: 'ro', topics: ['winery'] },
            { url: 'https://wineofmoldova.com/ro/turism-vitivinicol/', language: 'ro', topics: ['tourism'] },
            { url: 'https://wineofmoldova.com/ro/vinul-moldovei/', language: 'ro', topics: ['grape', 'wine'] },
            { url: 'https://wineofmoldova.com/ro/regiuni-vitivinicole/', language: 'ro', topics: ['region'] },
            { url: 'https://wineofmoldova.com/ro/stiri-si-media/', language: 'ro', topics: ['news'] },
            { url: 'https://wineofmoldova.com/ru/o-nbvv/', language: 'ru', topics: ['onvv'] },
            { url: 'https://wineofmoldova.com/ru/nashi-vinodelni/', language: 'ru', topics: ['winery'] },
            { url: 'https://wineofmoldova.com/ru/vinnyj-turizm/', language: 'ru', topics: ['tourism'] },
            { url: 'https://wineofmoldova.com/ru/moldavskoe-vino/', language: 'ru', topics: ['grape', 'wine'] },
            { url: 'https://wineofmoldova.com/ru/vinnye-regiony/', language: 'ru', topics: ['region'] },
            { url: 'https://wineofmoldova.com/ru/novosti-i-smi/', language: 'ru', topics: ['news'] },
        ],
    },
];

function requireValidTrust(trust) {
    if (!TRUST_LEVELS.includes(trust)) {
        throw Object.assign(new Error(`invalid_trust_level: ${trust}`), { code: 'invalid_trust_level' });
    }
}

for (const source of SOURCES) requireValidTrust(source.trust);

function listPages() {
    return SOURCES.flatMap((source) => source.pages.map((page) => ({
        ...page,
        sourceId: source.id,
        trust: source.trust,
        publisher: source.publisher,
    })));
}

module.exports = { SOURCES, TRUST_LEVELS, listPages };

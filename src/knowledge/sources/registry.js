'use strict';

// Source registry — see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.8. Every
// URL here was verified to actually exist (see the browser-verification
// note in the architecture doc) before being added — never guess a URL and
// hardcode it as a trusted source.
//
// Winery domains added so far (Purcari, Cricova) were each confirmed by
// navigating to the live site and reading its real nav links — same
// discipline as the ONVV source below. Other wineries (Castel Mimi,
// Mileștii Mici, Asconi, Chateau Vartely, ...) are NOT included yet —
// their domains were not successfully verified in this pass (one lookup
// attempt for Mileștii Mici's domain failed to resolve) and should go
// through the same check before being added, not be guessed.

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
    {
        // purcari.wine redirects here — Purcari Wineries Group (holding
        // company for Purcari, Bostavan, Crama Ceptura, Bardar). Confirmed
        // live via browser navigation, not guessed.
        id: 'purcari-group',
        type: 'winery',
        trust: 'A',
        publisher: 'Purcari Wineries',
        pages: [
            { url: 'https://purcariwineries.com/about/', language: 'ro', topics: ['winery'] },
            { url: 'https://purcariwineries.com/vinarii/', language: 'ro', topics: ['winery'] },
            { url: 'https://purcariwineries.com/turism/', language: 'ro', topics: ['tourism'] },
        ],
    },
    {
        id: 'cricova',
        type: 'winery',
        trust: 'A',
        publisher: 'Cricova',
        pages: [
            { url: 'https://cricova.md/ro', language: 'ro', topics: ['winery'] },
            { url: 'https://cricova.md/ro/vinuri/vinuri', language: 'ro', topics: ['winery', 'wine'] },
            { url: 'https://cricova.md/ro/excursii', language: 'ro', topics: ['tourism'] },
        ],
    },
    {
        // Independent trade-press outlet, not an official/government or
        // winery-owned source — trust B, so new/changed pages land in the
        // pending-review queue (Knowledge Monitor) rather than auto-approving.
        // NOTE: this crawler only re-fetches the fixed page URLs listed below
        // — it has no listing-page link-discovery step, so re-crawling the
        // category page itself only detects a content change on THAT page
        // (its "seen" list of latest headlines), not new individual articles
        // automatically. New articles must still be added here explicitly
        // once found/verified (see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md
        // for the planned discovery-module upgrade that would remove this
        // limitation). Individual article pages verified via WebFetch on
        // 2026-07-19 are listed alongside the category index.
        id: 'wine-and-spirits-md',
        type: 'news',
        trust: 'B',
        publisher: 'Wine and Spirits (wine-and-spirits.md)',
        pages: [
            { url: 'https://wine-and-spirits.md/category/vinodelni/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/vina-cricova-vernulis-na-rynok-ssha/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/milestii-mici-uvelichil-pribyl-bolee-chem-v-poltora-raza/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/gruppa-purcari-wineries-priobrela-biodinamicheskie-vinogradniki/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/gruppa-purcari-wineries-podvela-itogi-za-2025-g/', language: 'ru', topics: ['news', 'winery'] },
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

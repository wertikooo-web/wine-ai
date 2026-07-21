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
        // winery-owned source. Set to trust A per explicit user request
        // (2026-07-19) — discovered/updated pages from this source now
        // auto-approve and publish straight into knowledge/source/ without
        // landing in the Knowledge Monitor pending-review queue first.
        id: 'wine-and-spirits-md',
        type: 'news',
        trust: 'A',
        publisher: 'Wine and Spirits (wine-and-spirits.md)',
        pages: [
            { url: 'https://wine-and-spirits.md/vina-cricova-vernulis-na-rynok-ssha/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/milestii-mici-uvelichil-pribyl-bolee-chem-v-poltora-raza/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/gruppa-purcari-wineries-priobrela-biodinamicheskie-vinogradniki/', language: 'ru', topics: ['news', 'winery'] },
            { url: 'https://wine-and-spirits.md/gruppa-purcari-wineries-podvela-itogi-za-2025-g/', language: 'ru', topics: ['news', 'winery'] },
        ],
        // Discovery: on each update cycle, this category page's article
        // links are extracted and treated as newly-discovered `pages` for
        // this run (subject to the exact same trust/pending/dedup handling
        // as the hand-picked ones above). `linkPattern` matches this site's
        // plain article URL shape (https://wine-and-spirits.md/<slug>/) and
        // excludes /category/, /tag/, /page/N/, wp-content, etc.
        // Found via user report (2026-07-19): a page about a monument to
        // Moldovan wine was on-site but never entered the knowledge base.
        // Root cause — it lives in "Из истории молдавского виноделия"
        // (history), a category the crawler never visited; only
        // /category/vinodelni/ (winery-specific news) was covered. Verified
        // both this category's existence and the specific article's
        // membership in it via WebFetch before adding.
        listings: [
            {
                url: 'https://wine-and-spirits.md/category/vinodelni/',
                language: 'ru',
                topics: ['news', 'winery'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$',
                maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/iz-istorii-moldavskogo-vinodelia/',
                language: 'ru',
                topics: ['news', 'history'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$',
                maxNewLinksPerRun: 10,
            },
            // Added 2026-07-20 per user request, after auditing the site's
            // full category navigation (fetched live, not guessed) and
            // finding only 2 of ~30 categories were ever being crawled.
            // These are the categories judged in-scope for a Moldovan-wine
            // persona; explicitly excluded: other countries' winemaking
            // (Georgia/France/Italy/Austria/Portugal — out of this bot's
            // specialization), whisky, films, services, wine+music, cooking.
            {
                url: 'https://wine-and-spirits.md/category/o-moldavskom-vinodelii/',
                language: 'ru', topics: ['news', 'wine'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/moldavskie-vina/',
                language: 'ru', topics: ['news', 'wine'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-divinah/',
                language: 'ru', topics: ['news', 'divin'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/vinodely/',
                language: 'ru', topics: ['news', 'winery'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/urojai-po-godam/',
                language: 'ru', topics: ['news', 'wine'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/v-moldobe/',
                language: 'ru', topics: ['news'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/nasi-dostijenia/',
                language: 'ru', topics: ['news'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/statistika/',
                language: 'ru', topics: ['news', 'statistics'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/na-exportnih-rinkah/',
                language: 'ru', topics: ['news', 'export'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/den-vina/',
                language: 'ru', topics: ['news', 'tourism'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/interviu/',
                language: 'ru', topics: ['news', 'interview'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/gde-kupiti/',
                language: 'ru', topics: ['news'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-sortah/',
                language: 'ru', topics: ['news', 'grape'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-vinogradnikah/',
                language: 'ru', topics: ['news', 'grape'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-vine/',
                language: 'ru', topics: ['news', 'wine'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-degustatsii/',
                language: 'ru', topics: ['news', 'tasting'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            // Added 2026-07-20 per explicit user request — verified live via
            // WebFetch before adding.
            {
                url: 'https://wine-and-spirits.md/category/gotovim-s-vinom/',
                language: 'ru', topics: ['news', 'food'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            // Added 2026-07-20 per explicit user request — verified live via
            // WebFetch before adding. Health-content note: the persona
            // prompt already forbids categorical medical claims and
            // requires deferring to a doctor regardless of source material
            // (see src/persona/wineExpertPersona.js's "АЛКОГОЛЬ И ЗДОРОВЬЕ"
            // section) — that guardrail applies to anything retrieved from
            // this category too, no extra handling needed here.
            {
                url: 'https://wine-and-spirits.md/category/eda-i-vino/',
                language: 'ru', topics: ['news', 'food'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/napitki-na-osnove-vina-i-divina/',
                language: 'ru', topics: ['news', 'divin'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/o-vliyanii-alkogolya-na-zdorove/',
                language: 'ru', topics: ['news', 'health'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
            {
                url: 'https://wine-and-spirits.md/category/wine-hacks/',
                language: 'ru', topics: ['news', 'tips'],
                linkPattern: '^https://wine-and-spirits\\.md/[a-z0-9-]+/?$', maxNewLinksPerRun: 10,
            },
        ],
    },
    {
        // Official Moldovan national tourism portal. Added 2026-07-21 per
        // explicit user request; page existence and content verified live
        // (WebFetch) before adding — a one-day wine-tourism route covering
        // 6 small family wineries/artisan stops (Mihai Sava, Tronciu,
        // Conacul Mierii, Ceramica Triboi, Crama Tudor, Vornic Winery,
        // Pomușoara Dulcișoara), ~1500 words of real descriptive content.
        id: 'moldova-travel-official',
        type: 'official',
        trust: 'A',
        publisher: 'Moldova.Travel (National Tourism Portal)',
        pages: [
            { url: 'https://moldova.travel/ru/turisticheskiye-priklyucheniya/marshrut-avtorskih-vin/', language: 'ru', topics: ['tourism', 'winery'] },
        ],
    },
    {
        // Chișinău municipal tourism portal. Verified live (WebFetch)
        // 2026-07-21 per explicit user request — lists 13 wine venues
        // (urban tasting bars + ATU, Mileștii Mici, Cricova, Stăuceni wine
        // museum) as a city wine route.
        id: 'visit-chisinau-official',
        type: 'official',
        trust: 'A',
        publisher: 'Visit Chișinău (Municipal Tourism Portal)',
        pages: [
            { url: 'https://visit.chisinau.md/ru/routes/vinnyj-marshrut/', language: 'ru', topics: ['tourism', 'winery'] },
        ],
    },
    {
        // Verified live (WebFetch) 2026-07-21 per explicit user request.
        id: 'carlevana',
        type: 'winery',
        trust: 'A',
        publisher: 'Carlevana Winery',
        pages: [
            { url: 'https://carlevana.md/ru/vinnyy-tur-v-vinodelnyu-carlevana/', language: 'ru', topics: ['winery', 'tourism'] },
        ],
    },
    {
        // Verified live (WebFetch) 2026-07-21 per explicit user request.
        id: 'vinuri-de-comrat',
        type: 'winery',
        trust: 'A',
        publisher: 'Vinuri de Comrat',
        pages: [
            { url: 'https://vinuridecomrat.md/ru/turizm/', language: 'ru', topics: ['winery', 'tourism'] },
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

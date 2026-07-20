'use strict';

const { WINERY, WINE, getScreenContext, buildContextualPersona } = require('../src/persona/screenContexts');
const { CORE_PERSONA_PROMPT } = require('../src/persona/wineExpertPersona');
const t = require('./helpers/assertions');

async function run() {
    // Lookup: valid type+id pairs resolve, everything else returns null
    // rather than throwing — the server route depends on this to return a
    // clean 404 instead of crashing the request handler.
    t.equal(getScreenContext('winery', WINERY.id).name, 'Crama Dealul de Aur');
    t.equal(getScreenContext('wine', WINE.id).name, 'Dealul de Aur Fetească Neagră Reserve 2019');
    t.equal(getScreenContext('winery', 'not-a-real-id'), null, 'wrong id for a known type must not resolve');
    t.equal(getScreenContext('wine', WINERY.id), null, 'a winery id must not resolve under type=wine');
    t.equal(getScreenContext('bogus-type', WINERY.id), null, 'unknown context type must not resolve');

    // Context prompt: must layer on top of (never replace) the real base
    // persona, so every safety/style rule still applies to a contextual
    // session.
    const wineryPersona = buildContextualPersona(WINERY);
    t.ok(wineryPersona.includes(CORE_PERSONA_PROMPT), 'contextual persona must contain the full base persona verbatim');
    t.ok(wineryPersona.includes(WINERY.openingLine), 'contextual persona must instruct the exact opening line');
    t.ok(wineryPersona.includes(WINERY.name), 'contextual persona must name the winery being viewed');

    const winePersona = buildContextualPersona(WINE);
    t.ok(winePersona.includes(WINE.openingLine), 'wine context must instruct its own opening line');
    t.ok(winePersona.includes('Crama Dealul de Aur'), 'wine context must reference its parent winery');
    t.ok(!winePersona.includes(WINERY.openingLine), 'wine context must not leak the winery opening line');

    // The two contexts must not bleed into each other.
    t.ok(!wineryPersona.includes(WINE.openingLine), 'winery context must not include the wine opening line');
}

module.exports = { run };

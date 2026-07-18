'use strict';

const { detectLikelyLanguage } = require('../src/realtime/realtimeServer');
const t = require('./helpers/assertions');

async function run() {
    t.equal(detectLikelyLanguage('Расскажи, чем Фетяска Нягрэ отличается от Каберне Совиньон.'), 'ru');
    t.equal(detectLikelyLanguage('Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.'), 'ro');
    t.equal(detectLikelyLanguage('Which Moldovan wine would you recommend with roast lamb?'), 'en');

    // A Russian sentence that happens to contain a Romanian wine-domain word
    // must stay ambiguous (or Russian) rather than flip to Romanian purely
    // because of one embedded proper noun — the low-level per-utterance
    // detector ties/defers here; the session-level noteUserLanguage()
    // confirmation-count gate (exercised in tests/realtimeLifecycle.test.js)
    // is the second layer that prevents an actual mid-session flip.
    const mixedResult = detectLikelyLanguage('Расскажи мне про молдавскую Crama Purcari');
    t.ok(mixedResult === 'ru' || mixedResult === null, `expected 'ru' or an ambiguous null for a Russian sentence containing a Romanian proper noun, got ${mixedResult}`);

    // Too short / ambiguous input yields no verdict rather than a guess.
    t.equal(detectLikelyLanguage('ok'), null);
    t.equal(detectLikelyLanguage(''), null);
}

module.exports = { run };

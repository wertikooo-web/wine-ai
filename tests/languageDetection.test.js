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

    // Expanded language set (fr/it/es/de/zh/ja) — added after "Hold to
    // talk"/language-selector work. Each of these previously tied with a
    // wine-domain cognate shared across Romance languages ("vin"/"vino")
    // before that vocabulary was removed from the disambiguating word
    // lists — see the comment above LANGUAGE_PATTERNS in realtimeServer.js.
    t.equal(detectLikelyLanguage('Bonjour, quel vin recommandez-vous avec ce plat?'), 'fr');
    t.equal(detectLikelyLanguage('Ciao, quale vino consigli per questo piatto?'), 'it');
    t.equal(detectLikelyLanguage('Hola, ¿qué vino me recomienda?'), 'es');
    t.equal(detectLikelyLanguage('Guten Tag, welchen Wein empfehlen Sie?'), 'de');
    t.equal(detectLikelyLanguage('你好，请问摩尔多瓦的葡萄酒怎么样'), 'zh');
    t.equal(detectLikelyLanguage('こんにちは、ワインについて教えてください'), 'ja');
}

module.exports = { run };

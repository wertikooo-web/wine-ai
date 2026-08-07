'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'visual', 'StartIntentLauncher.mjs')).href;
  const { START_INTENTS, getStartIntentCopy, normalizeStartIntentLanguage } = await import(moduleUrl);

  assert.deepStrictEqual(
    START_INTENTS.map((intent) => intent.id),
    ['choose_wine', 'pair_food', 'learn_wine', 'visit_winery'],
    'start screen must expose exactly four stable intents'
  );

  for (const lang of ['ru', 'ro', 'en', 'fr', 'it', 'es', 'de', 'zh', 'ja']) {
    for (const intent of START_INTENTS) {
      const copy = getStartIntentCopy(intent.id, lang);
      assert(copy, `${lang}/${intent.id} copy is required`);
      assert(copy.label.length > 0, `${lang}/${intent.id} label is required`);
      assert(copy.starter.length > copy.label.length, `${lang}/${intent.id} starter should carry conversational context`);
    }
  }

  assert.strictEqual(normalizeStartIntentLanguage('RU'), 'ru');
  assert.strictEqual(normalizeStartIntentLanguage('unknown'), 'en');
  assert.strictEqual(getStartIntentCopy('missing', 'ru'), null);

  const pairingRu = getStartIntentCopy('pair_food', 'ru');
  assert(pairingRu.starter.includes('спроси'), 'food pairing should begin with a clarifying question');
  const chooseEn = getStartIntentCopy('choose_wine', 'en');
  assert(chooseEn.starter.toLowerCase().includes('ask one short question'), 'wine choice should ask one short follow-up first');

  console.log('startIntentLauncher.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

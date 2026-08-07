'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentLauncher.mjs')).href;
  const {
    START_INTENTS,
    getStartIntentCopy,
    normalizeStartIntentLanguage,
    detectVoiceMode,
    isFreeConversationActive,
  } = await import(moduleUrl);

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

  const makeDocument = ({ tapActive = false, timerHidden = true } = {}) => ({
    getElementById(id) {
      if (id === 'voiceModeTapBtn') {
        return { classList: { contains: (name) => name === 'active' && tapActive } };
      }
      if (id === 'voiceSessionTimer') return { hidden: timerHidden };
      return null;
    },
  });

  assert.strictEqual(detectVoiceMode(makeDocument({ tapActive: true })), 'tap_to_start');
  assert.strictEqual(detectVoiceMode(makeDocument({ tapActive: false })), 'hold_to_talk');
  assert.strictEqual(isFreeConversationActive(makeDocument({ timerHidden: false })), true);
  assert.strictEqual(isFreeConversationActive(makeDocument({ timerHidden: true })), false);

  console.log('startIntentLauncher.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

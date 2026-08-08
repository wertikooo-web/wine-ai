'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const launcherUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentLauncher.mjs')).href;
  const orchestratorUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'ConversationOrchestrator.mjs')).href;
  const {
    START_INTENTS,
    START_INTENT_LANGUAGES,
    getStartIntentCopy,
    getStartIntentConfig,
    saveStartIntentConfig,
    resetStartIntentConfig,
    normalizeStartIntentLanguage,
    detectVoiceMode,
    isFreeConversationActive,
  } = await import(launcherUrl);
  const { ConversationOrchestrator, CONVERSATION_STATES } = await import(orchestratorUrl);

  assert.deepStrictEqual(START_INTENTS.map((intent) => intent.id), ['choose_wine', 'pair_food', 'learn_wine', 'visit_winery']);
  assert.deepStrictEqual(START_INTENT_LANGUAGES, ['ru', 'ro', 'en', 'fr', 'it', 'es', 'de', 'zh', 'ja']);

  for (const lang of START_INTENT_LANGUAGES) {
    for (const intent of START_INTENTS) {
      const copy = getStartIntentCopy(intent.id, lang, null);
      assert(copy, `${lang}/${intent.id} copy is required`);
      assert(copy.label.length > 0);
      assert(copy.openingLine.length > 0);
      assert(copy.context.length > 0);
      assert(copy.starter.includes(copy.openingLine));
    }
  }

  assert.strictEqual(normalizeStartIntentLanguage('RU'), 'ru');
  assert.strictEqual(normalizeStartIntentLanguage('unknown'), 'en');
  assert.strictEqual(getStartIntentCopy('missing', 'ru', null), null);

  const memoryStorage = (() => {
    const data = new Map();
    return {
      getItem: (key) => data.has(key) ? data.get(key) : null,
      setItem: (key, value) => data.set(key, String(value)),
    };
  })();

  saveStartIntentConfig('pair_food', 'ru', {
    label: 'К ужину',
    openingLine: 'Что сегодня на ужин?',
    context: 'Подбери вино к ужину.',
    enabled: true,
  }, memoryStorage);
  const customized = getStartIntentCopy('pair_food', 'ru', memoryStorage);
  assert.strictEqual(customized.label, 'К ужину');
  assert.strictEqual(customized.openingLine, 'Что сегодня на ужин?');
  assert(customized.starter.includes('Подбери вино к ужину.'));
  assert(customized.starter.includes('Что сегодня на ужин?'));

  saveStartIntentConfig('visit_winery', 'ru', { enabled: false }, memoryStorage);
  assert.strictEqual(getStartIntentConfig('visit_winery', 'ru', memoryStorage).enabled, false);
  resetStartIntentConfig('visit_winery', 'ru', memoryStorage);
  assert.strictEqual(getStartIntentConfig('visit_winery', 'ru', memoryStorage).enabled, true);

  const makeDocument = ({ tapActive = false, timerHidden = true } = {}) => ({
    getElementById(id) {
      if (id === 'voiceModeTapBtn') return { classList: { contains: (name) => name === 'active' && tapActive } };
      if (id === 'voiceSessionTimer') return { hidden: timerHidden };
      return null;
    },
  });
  assert.strictEqual(detectVoiceMode(makeDocument({ tapActive: true })), 'tap_to_start');
  assert.strictEqual(detectVoiceMode(makeDocument({ tapActive: false })), 'hold_to_talk');
  assert.strictEqual(isFreeConversationActive(makeDocument({ timerHidden: false })), true);
  assert.strictEqual(isFreeConversationActive(makeDocument({ timerHidden: true })), false);

  function makeAdapter({ connected = false, freeActive: initialFreeActive = false } = {}) {
    const events = [];
    let isConnected = connected;
    let freeActive = initialFreeActive;
    return {
      events,
      isConnected: () => isConnected,
      async connect() { events.push('connect'); isConnected = true; },
      async waitForTextChannelReady() { events.push('text_ready'); },
      async submitStarter(text) { events.push(`starter:${text}`); },
      async waitForAssistantSpeechStart() { events.push('assistant_speaking'); },
      async waitForAssistantSpeechDrain() { events.push('assistant_drained'); },
      async startFreeConversation() { events.push('free_start'); freeActive = true; },
      async stopFreeConversation() { events.push('free_stop'); freeActive = false; },
      isFreeConversationActive: () => freeActive,
      async waitForFreeConversationActive() { events.push('free_active'); assert.strictEqual(freeActive, true); },
      async waitForFreeConversationInactive() { events.push('free_inactive'); assert.strictEqual(freeActive, false); },
      async waitForHoldToTalkReady() { events.push('hold_ready'); },
    };
  }

  const freeAdapter = makeAdapter();
  const freeStates = [];
  const free = new ConversationOrchestrator(freeAdapter, { onStateChange: (state) => freeStates.push(state) });
  const freeResult = await free.start({ starter: 'PAIR FOOD', mode: 'tap_to_start' });
  assert.strictEqual(freeResult, CONVERSATION_STATES.LISTENING);
  assert.deepStrictEqual(freeAdapter.events, ['connect','text_ready','starter:PAIR FOOD','assistant_speaking','assistant_drained','free_start','free_active']);
  assert(freeAdapter.events.indexOf('assistant_drained') < freeAdapter.events.indexOf('free_start'));

  const activeAdapter = makeAdapter({ connected: true, freeActive: true });
  const active = new ConversationOrchestrator(activeAdapter);
  await active.start({ starter: 'WINERIES', mode: 'tap_to_start' });
  assert.deepStrictEqual(activeAdapter.events, ['free_stop','free_inactive','text_ready','starter:WINERIES','assistant_speaking','assistant_drained','free_start','free_active']);

  const holdAdapter = makeAdapter();
  const hold = new ConversationOrchestrator(holdAdapter);
  const holdResult = await hold.start({ starter: 'CHOOSE WINE', mode: 'hold_to_talk' });
  assert.strictEqual(holdResult, CONVERSATION_STATES.HOLD_READY);
  assert(!holdAdapter.events.includes('free_start'));

  console.log('startIntentLauncher.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

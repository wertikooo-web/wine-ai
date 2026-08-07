'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const launcherUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentLauncher.mjs')).href;
  const orchestratorUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'ConversationOrchestrator.mjs')).href;
  const {
    START_INTENTS,
    getStartIntentCopy,
    normalizeStartIntentLanguage,
    detectVoiceMode,
    isFreeConversationActive,
  } = await import(launcherUrl);
  const { ConversationOrchestrator, CONVERSATION_STATES } = await import(orchestratorUrl);

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

  function makeAdapter({ connected = false } = {}) {
    const events = [];
    let isConnected = connected;
    let freeActive = false;
    return {
      events,
      isConnected: () => isConnected,
      async connect() { events.push('connect'); isConnected = true; },
      async waitForTextChannelReady() { events.push('text_ready'); },
      async submitStarter(text) { events.push(`starter:${text}`); },
      async waitForAssistantSpeechStart() { events.push('assistant_speaking'); },
      async waitForAssistantSpeechDrain() { events.push('assistant_drained'); },
      async startFreeConversation() { events.push('free_start'); freeActive = true; },
      isFreeConversationActive: () => freeActive,
      async waitForFreeConversationActive() { events.push('free_active'); assert.strictEqual(freeActive, true); },
      async waitForHoldToTalkReady() { events.push('hold_ready'); },
    };
  }

  // Integration-level ordering invariant for the production bug we hit:
  // opening intent MUST finish its assistant reply before Free Conversation
  // arms the continuous microphone. Starting free audio first creates a
  // tap_to_start generation that input_text.submit immediately cancels.
  const freeAdapter = makeAdapter();
  const freeStates = [];
  const free = new ConversationOrchestrator(freeAdapter, { onStateChange: (state) => freeStates.push(state) });
  const freeResult = await free.start({ starter: 'PAIR FOOD', mode: 'tap_to_start' });
  assert.strictEqual(freeResult, CONVERSATION_STATES.LISTENING);
  assert.deepStrictEqual(freeAdapter.events, [
    'connect',
    'text_ready',
    'starter:PAIR FOOD',
    'assistant_speaking',
    'assistant_drained',
    'free_start',
    'free_active',
  ]);
  assert(
    freeAdapter.events.indexOf('starter:PAIR FOOD') < freeAdapter.events.indexOf('free_start'),
    'starter must be submitted before continuous audio starts'
  );
  assert(
    freeAdapter.events.indexOf('assistant_drained') < freeAdapter.events.indexOf('free_start'),
    'continuous audio must start only after the opening assistant reply drains'
  );
  assert.deepStrictEqual(freeStates, [
    CONVERSATION_STATES.CONNECTING,
    CONVERSATION_STATES.READY,
    CONVERSATION_STATES.OPENING_TURN,
    CONVERSATION_STATES.ASSISTANT_SPEAKING,
    CONVERSATION_STATES.ARMING_LISTENING,
    CONVERSATION_STATES.LISTENING,
  ]);

  const holdAdapter = makeAdapter();
  const hold = new ConversationOrchestrator(holdAdapter);
  const holdResult = await hold.start({ starter: 'CHOOSE WINE', mode: 'hold_to_talk' });
  assert.strictEqual(holdResult, CONVERSATION_STATES.HOLD_READY);
  assert.deepStrictEqual(holdAdapter.events, [
    'connect',
    'text_ready',
    'starter:CHOOSE WINE',
    'assistant_speaking',
    'assistant_drained',
    'hold_ready',
  ]);
  assert(!holdAdapter.events.includes('free_start'), 'Hold to Talk must never arm continuous audio');

  console.log('startIntentLauncher.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

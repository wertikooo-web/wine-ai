'use strict';

const assert = require('assert');
const ui = require('../public/voice-engine-ui');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    dump() { return Object.fromEntries(values.entries()); },
  };
}

async function run() {
  let n = 0;
  const equal = (actual, expected, message) => {
    n += 1;
    assert.strictEqual(actual, expected, message);
  };

  equal(ui.normalizeEngineFamily('classic'), 'classic');
  equal(ui.normalizeEngineFamily('gemini'), 'realtime');
  equal(ui.normalizeConversationMode('tap_to_start'), 'open_conversation');
  equal(ui.normalizeConversationMode('free_conversation'), 'open_conversation');
  equal(ui.normalizeConversationMode('hold_to_talk'), 'hold_to_talk');

  const oldGemini = storage({ selectedRealtimeProvider: 'gemini', voiceMode: 'tap_to_start' });
  const migratedGemini = ui.loadState(oldGemini);
  equal(migratedGemini.engineFamily, 'realtime');
  equal(migratedGemini.conversationMode, 'open_conversation');
  equal(migratedGemini.realtimeProvider, 'gemini');
  equal(ui.resolveRuntimeProvider(migratedGemini), 'gemini');

  const oldGrok = storage({ realtimeProvider: 'grok', voiceMode: 'hold_to_talk' });
  const migratedGrok = ui.loadState(oldGrok);
  equal(migratedGrok.engineFamily, 'realtime');
  equal(migratedGrok.realtimeProvider, 'grok');
  equal(ui.resolveRuntimeProvider(migratedGrok), 'grok');

  const classic = storage({
    'wineai.engineFamily': 'classic',
    'wineai.conversationMode': 'open_conversation',
    'wineai.realtimeProvider': 'grok',
  });
  const classicState = ui.loadState(classic);
  equal(classicState.engineFamily, 'classic');
  equal(classicState.conversationMode, 'open_conversation');
  equal(ui.resolveRuntimeProvider(classicState), 'classic');

  ui.saveState(classic, {
    engineFamily: 'realtime',
    conversationMode: 'hold_to_talk',
    realtimeProvider: 'gemini',
  });
  const saved = classic.dump();
  equal(saved['wineai.engineFamily'], 'realtime');
  equal(saved['wineai.conversationMode'], 'hold_to_talk');
  equal(saved['wineai.realtimeProvider'], 'gemini');

  console.log(`voiceEngineUi: ${n} assertions OK`);
  return { assertionCount: n };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };

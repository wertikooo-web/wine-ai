'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const dashboard = fs.readFileSync('public/dashboard.html', 'utf8');
const server = fs.readFileSync('src/realtime/realtimeServer.js', 'utf8');
const persona = fs.readFileSync('src/persona/wineExpertPersona.js', 'utf8');

test('scripted text turns preserve tap-to-start continuous audio', () => {
  assert.match(server, /let sessionVoiceMode = currentMode/);
  assert.match(server, /continuousTapListening = sessionVoiceMode === 'tap_to_start'/);
  assert.match(server, /payload\.type === 'input_audio\.speech_start'/);
});

test('local VAD provides prompt speech-start bookkeeping', () => {
  assert.match(dashboard, /type: 'input_audio\.speech_start'/);
  assert.match(dashboard, /if \(confirmed && !sessionLimitInputClosed\)/);
});

test('deadline grants a final turn that began before zero', () => {
  assert.match(dashboard, /sessionLimitFinalTurnPending = true/);
  assert.match(dashboard, /sessionLimitLocalSpeechStartedAt <= sessionLimitDeadlineAt/);
  assert.match(dashboard, /payload\.turn_id === sessionLimitFinalTurnId/);
  assert.match(dashboard, /phase: 'await_drain'/);
});

test('spoken warning cannot interrupt a busy conversation', () => {
  assert.match(dashboard, /session_limit_warning_deferred/);
  assert.match(dashboard, /freeConversationUserTurnOpen \|\| localSpeechActive \|\| activeSources\.size > 0 \|\| DeviceVisual\.getState\(\) === 'thinking'/);
});

test('persona does not force RAG and web for unrelated questions', () => {
  assert.doesNotMatch(persona, /Для ЛЮБОГО содержательного вопроса/);
  assert.doesNotMatch(persona, /сначала ОБЯЗАТЕЛЬНО выполни поиск/);
  assert.match(persona, /Не запускай RAG для приветствий/);
  assert.match(persona, /Не запускай search_web автоматически/);
});

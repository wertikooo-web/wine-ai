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


test('synthetic text warning is not mistaken for a user audio turn', () => {
  assert.ok(server.includes('mode: currentMode'));
  assert.ok(dashboard.includes("voiceMode === 'tap_to_start' && payload.mode === 'tap_to_start'"));
});

test('deadline waits for a pre-deadline turn that is still thinking', () => {
  assert.ok(dashboard.includes("const responseStillThinking = DeviceVisual.getState() === 'thinking'"));
  assert.ok(dashboard.includes('freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline || responseStillThinking'));
});

test('grandfathered final turn failure closes cleanly', () => {
  assert.ok(dashboard.includes("case 'response.failed':"));
  assert.ok(dashboard.includes("triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT)"));
});

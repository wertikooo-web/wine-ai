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
  assert.match(dashboard, /if \(localSpeechActive \|\| activeSources\.size > 0 \|\| DeviceVisual\.getState\(\) === 'thinking'\)/);
});

// Production 29 Sep (/lite probe): the 0:30 warning was deferred every time
// and never spoken -- freeConversationUserTurnOpen is true between
// utterances in Free Conversation. A deferred warning is retried instead.
test('spoken warning is not blocked by the always-open Free Conversation turn, and is retried', () => {
  assert.doesNotMatch(dashboard, /freeConversationUserTurnOpen \|\| localSpeechActive/);
  assert.match(dashboard, /sessionLimitWarnTimer = setTimeout\(trySpokenWarning, 2000\)/);
});

// Production 29 Sep (/lite probe): a question asked at 2:57 got no answer,
// the closing line was never spoken, and the WebSocket stayed open past
// 0:00 (the client waited for the closing line forever).
test('a question asked before 0:00 without an answer yet is still answered', () => {
  assert.match(dashboard, /lastLocalUtteranceStartedAt <= sessionLimitDeadlineAt\s*&& lastLocalUtteranceStartedAt > lastAnswerAudioStartedAt/);
  assert.ok(dashboard.includes('if (localSpeechBeganBeforeDeadline || responseStillThinking || answerOwedForSpeechBeforeDeadline) {'));
});

test('the closing sequence always ends the session, even if the closing line never plays', () => {
  assert.match(dashboard, /const AUTO_END_CLOSING_FALLBACK_MS = 10000/);
  assert.match(dashboard, /auto_end_fallback_disconnect[\s\S]{0,120}performAutoEnd\(reason\)/);
  assert.match(dashboard, /pendingAutoEnd\.phase = 'closing_sent';\s*armAutoEndFallback\(AUTO_END_CLOSING_FALLBACK_MS\)/);
  assert.match(dashboard, /if \(reason === 'session_timeout'\) sessionLimitInputClosed = true;/);
});

test('the server backstop ends the session in the client', () => {
  assert.match(dashboard, /case 'session\.ended':[\s\S]{0,200}performAutoEnd\(/);
  assert.match(server, /log\('session_limit_server_close'/);
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
  assert.ok(dashboard.includes('if (localSpeechBeganBeforeDeadline || responseStillThinking || answerOwedForSpeechBeforeDeadline) {'));
});

// Production 29 Sep: /lite kept talking past 3:00. In Free Conversation the
// input turn stays open between utterances, so an "open turn" grace was
// granted at every deadline to an already-answered turn and never resolved.
test('deadline is not deferred just because the Free Conversation input turn is open', () => {
  assert.doesNotMatch(dashboard, /if \(freeConversationUserTurnOpen \|\| localSpeechBeganBeforeDeadline/);
});

test('a granted final turn has an absolute backstop', () => {
  assert.match(dashboard, /const FREE_CONV_SESSION_FINAL_GRACE_MS = \d+/);
  assert.match(dashboard, /session_limit_grace_expired[\s\S]{0,80}triggerAutoEnd\('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT\)/);
  assert.match(dashboard, /if \(sessionLimitGraceTimer\) \{ clearTimeout\(sessionLimitGraceTimer\)/);
});

test('grandfathered final turn failure closes cleanly', () => {
  assert.ok(dashboard.includes("case 'response.failed':"));
  assert.ok(dashboard.includes("triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT)"));
});

// Production 29 Sep (/lite probe after the fix): the deadline stayed 0 for
// the whole conversation -- the countdown display reset the session-limit
// state right after the timers were armed -- so the final-turn grace and the
// warning retry never applied.
test('session-limit timers are armed after the countdown state reset', () => {
  const start = dashboard.indexOf('function resumeTapListening()');
  const body = dashboard.slice(start, start + 2500);
  const display = body.indexOf('startVoiceSessionTimerDisplay();');
  const arm = body.indexOf('armSessionLimitTimers();');
  assert.ok(display > 0 && arm > 0 && display < arm, 'startVoiceSessionTimerDisplay() (resets sessionLimitDeadlineAt) must run before armSessionLimitTimers()');
  assert.match(dashboard, /function resetSessionLimitTurnState\(\) \{\s*sessionLimitDeadlineAt = 0;/);
});

// Production 29 Sep (probe after #91): the final answer ended ~3:15 but the
// closing line waited for the 45s grace to expire (3:46).
test('the first answer after 0:00 is treated as the final answer', () => {
  assert.ok(dashboard.includes("&& (!sessionLimitFinalTurnId || payload.turn_id === sessionLimitFinalTurnId)) {"));
});

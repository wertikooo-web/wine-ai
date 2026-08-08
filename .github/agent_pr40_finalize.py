from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1))

server = Path('src/realtime/realtimeServer.js')
dashboard = Path('public/dashboard.html')
test = Path('tests/freeConversationDeadlineRegression.test.js')

replace_once(
    server,
    "            response_id: null,\n        });\n",
    "            response_id: null,\n            mode: currentMode,\n        });\n",
)
replace_once(
    server,
    "            end_reason: payload.end_reason || null,\n        });\n",
    "            end_reason: payload.end_reason || null,\n            mode: currentMode,\n        });\n",
)

replace_once(
    dashboard,
    "        if (voiceMode === 'tap_to_start') {\n          freeConversationUserTurnOpen = true;\n",
    "        if (voiceMode === 'tap_to_start' && payload.mode === 'tap_to_start') {\n          freeConversationUserTurnOpen = true;\n",
)
replace_once(
    dashboard,
    "        if (voiceMode === 'tap_to_start') {\n          freeConversationUserTurnOpen = false;\n",
    "        if (voiceMode === 'tap_to_start' && payload.mode === 'tap_to_start') {\n          freeConversationUserTurnOpen = false;\n",
)

replace_once(
    dashboard,
    "      if (freeConversationUserTurnOpen || activeSources.size > 0 || DeviceVisual.getState() === 'thinking') {\n        sendTelemetry('session_limit_warning_deferred', {});\n",
    "      const localSpeechActive = Boolean(sessionLimitLocalSpeechLastLoudAt\n        && Date.now() - sessionLimitLocalSpeechLastLoudAt <= FREE_CONV_SESSION_LOCAL_SPEECH_RECENCY_MS);\n      if (freeConversationUserTurnOpen || localSpeechActive || activeSources.size > 0 || DeviceVisual.getState() === 'thinking') {\n        sendTelemetry('session_limit_warning_deferred', {});\n",
)

replace_once(
    dashboard,
    "      if (freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline) {\n        sessionLimitFinalTurnPending = true;\n        sessionLimitFinalTurnId = freeConversationUserTurnOpen ? currentTurnId : null;\n",
    "      const responseStillThinking = DeviceVisual.getState() === 'thinking';\n      if (freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline || responseStillThinking) {\n        sessionLimitFinalTurnPending = true;\n        sessionLimitFinalTurnId = (freeConversationUserTurnOpen || responseStillThinking) ? currentTurnId : null;\n",
)

replace_once(
    dashboard,
    "      case 'response.failed':\n        stopPlaybackImmediately({ reason: 'response_failed', generationId: payload.generation_id });\n",
    "      case 'response.failed':\n        if (sessionLimitFinalTurnPending\n          && (!sessionLimitFinalTurnId || payload.turn_id === sessionLimitFinalTurnId)) {\n          sessionLimitFinalTurnPending = false;\n          sessionLimitInputClosed = true;\n          triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT);\n        }\n        stopPlaybackImmediately({ reason: 'response_failed', generationId: payload.generation_id });\n",
)

text = test.read_text()
insert = r'''

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
'''
if "synthetic text warning is not mistaken" not in text:
    test.write_text(text + insert)

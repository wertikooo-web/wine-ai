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

# Surface turn mode to the client. Synthetic scripted text turns also emit
# input_audio.start, so without this field the client cannot distinguish them
# from a real Tap-to-Start user turn.
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

# Only native/client Tap-to-Start audio turns count as user speech for the
# deadline state machine. A synthetic text warning must never set this flag.
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

# Do not speak the 30s warning on top of locally-detected user speech that has
# started but whose server input_audio.start event has not arrived yet.
replace_once(
    dashboard,
    "      if (freeConversationUserTurnOpen || activeSources.size > 0 || DeviceVisual.getState() === 'thinking') {\n        sendTelemetry('session_limit_warning_deferred', {});\n",
    "      const localSpeechActive = Boolean(sessionLimitLocalSpeechLastLoudAt\n        && Date.now() - sessionLimitLocalSpeechLastLoudAt <= FREE_CONV_SESSION_LOCAL_SPEECH_RECENCY_MS);\n      if (freeConversationUserTurnOpen || localSpeechActive || activeSources.size > 0 || DeviceVisual.getState() === 'thinking') {\n        sendTelemetry('session_limit_warning_deferred', {});\n",
)

# If the user finished the final pre-deadline utterance but Gemini is still
# thinking at 0:00, grandfather the in-flight response too. Otherwise the
# closing text turn would cancel the answer before its first audio.start.
replace_once(
    dashboard,
    "      if (freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline) {\n        sessionLimitFinalTurnPending = true;\n        sessionLimitFinalTurnId = freeConversationUserTurnOpen ? currentTurnId : null;\n",
    "      const responseStillThinking = DeviceVisual.getState() === 'thinking';\n      if (freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline || responseStillThinking) {\n        sessionLimitFinalTurnPending = true;\n        sessionLimitFinalTurnId = (freeConversationUserTurnOpen || responseStillThinking) ? currentTurnId : null;\n",
)

# If the grandfathered final turn fails before audio.start, close cleanly
# instead of leaving the session pending forever.
replace_once(
    dashboard,
    "      case 'response.failed':\n        stopPlaybackImmediately({ reason: 'response_failed', generationId: payload.generation_id });\n",
    "      case 'response.failed':\n        if (sessionLimitFinalTurnPending\n          && (!sessionLimitFinalTurnId || payload.turn_id === sessionLimitFinalTurnId)) {\n          sessionLimitFinalTurnPending = false;\n          sessionLimitInputClosed = true;\n          triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT);\n        }\n        stopPlaybackImmediately({ reason: 'response_failed', generationId: payload.generation_id });\n",
)

# Strengthen regression coverage for these exact edges. Use includes() for
# multiline source snippets to avoid fragile regex escaping across generators.
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
if "synthetic text warning is not mistaken" in text:
    raise SystemExit('follow-up tests already present')
test.write_text(text + insert)

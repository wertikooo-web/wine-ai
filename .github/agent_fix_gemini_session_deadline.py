from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


server_path = Path('src/realtime/realtimeServer.js')
dashboard_path = Path('public/dashboard.html')
persona_path = Path('src/persona/wineExpertPersona.js')

# 1. Keep the session-wide microphone mode separate from the type of one turn.
replace_once(
    server_path,
    "    let currentMode = personaStore.getVoiceMode() === 'tap_to_start' ? 'tap_to_start' : 'push_to_talk';\n",
    "    let currentMode = personaStore.getVoiceMode() === 'tap_to_start' ? 'tap_to_start' : 'push_to_talk';\n    // Session-wide microphone mode. A scripted warning is a TEXT turn, but\n    // it must never switch Free Conversation out of continuous listening.\n    let sessionVoiceMode = currentMode;\n",
)

server = server_path.read_text()
start_marker = "        currentMode = payload.mode || 'push_to_talk';\n"
if start_marker not in server:
    raise SystemExit('startInput currentMode marker missing')
server = server.replace(
    start_marker,
    start_marker + "        if (currentMode === 'tap_to_start' || currentMode === 'push_to_talk') {\n            sessionVoiceMode = currentMode;\n        }\n",
    1,
)
server = server.replace("if (currentMode !== 'tap_to_start') return;", "if (sessionVoiceMode !== 'tap_to_start') return;")
server = server.replace("if (currentMode === 'tap_to_start' && !inputEndedAt)", "if (sessionVoiceMode === 'tap_to_start' && !inputEndedAt)")
server = server.replace(
    "const continuousTapListening = currentMode === 'tap_to_start' && turnCounter > 0;",
    "const continuousTapListening = sessionVoiceMode === 'tap_to_start' && turnCounter > 0;",
)
if "continuousTapListening = sessionVoiceMode === 'tap_to_start'" not in server:
    raise SystemExit('continuous listening replacement failed')
server_path.write_text(server)

# 2. Client local VAD gives our server a prompt speech-start hint. Gemini still
# decides the authoritative end-of-speech boundary.
replace_once(
    server_path,
    "        } else if (payload.type === 'input_audio.end') {\n            endInput(payload);\n        } else if (payload.type === 'input_text.submit') {\n",
    "        } else if (payload.type === 'input_audio.end') {\n            endInput(payload);\n        } else if (payload.type === 'input_audio.speech_start') {\n            if (sessionVoiceMode === 'tap_to_start') {\n                log('client_local_speech_started', { provider: providerSession?.name || 'provider' });\n                handleNativeSpeechStarted();\n            }\n        } else if (payload.type === 'input_text.submit') {\n",
)

dashboard = dashboard_path.read_text()

old = "  let sessionLimitWarnTimer = null;\n  let sessionLimitEndTimer = null;\n  let freeConversationStartedAt = null; // set once per conversation, in resumeTapListening()\n  let voiceSessionTickInterval = null;\n"
new = old + "  let sessionLimitDeadlineAt = 0;\n  let sessionLimitExpired = false;\n  let sessionLimitFinalTurnPending = false;\n  let sessionLimitFinalTurnId = null;\n  let sessionLimitInputClosed = false;\n  let freeConversationUserTurnOpen = false;\n  let sessionLimitLocalSpeechStartedAt = 0;\n  let sessionLimitLocalSpeechLastLoudAt = 0;\n  const FREE_CONV_SESSION_LOCAL_SPEECH_RECENCY_MS = 900;\n\n  function resetSessionLimitTurnState() {\n    sessionLimitDeadlineAt = 0;\n    sessionLimitExpired = false;\n    sessionLimitFinalTurnPending = false;\n    sessionLimitFinalTurnId = null;\n    sessionLimitInputClosed = false;\n    freeConversationUserTurnOpen = false;\n    sessionLimitLocalSpeechStartedAt = 0;\n    sessionLimitLocalSpeechLastLoudAt = 0;\n  }\n"
if old not in dashboard:
    raise SystemExit('deadline state marker missing')
dashboard = dashboard.replace(old, new, 1)

dashboard = dashboard.replace(
    "  function startVoiceSessionTimerDisplay() {\n    stopVoiceSessionTimerDisplay();\n    freeConversationStartedAt = Date.now();\n",
    "  function startVoiceSessionTimerDisplay() {\n    stopVoiceSessionTimerDisplay();\n    resetSessionLimitTurnState();\n    freeConversationStartedAt = Date.now();\n",
    1,
)

old_arm = """  function armSessionLimitTimers() {
    clearSessionLimitTimers();
    const limitMs = freeConversationSessionLimitMs;
    const warnAt = Math.max(0, limitMs - FREE_CONV_SESSION_WARNING_LEAD_MS);
    sessionLimitWarnTimer = setTimeout(() => {
      sessionLimitWarnTimer = null;
      if (!(voiceMode === 'tap_to_start' && tapToStartActive)) return;
      speakScriptedLine(FREE_CONV_SESSION_WARNING_TEXT);
      sendTelemetry('session_limit_warning_spoken', {});
    }, warnAt);
    sessionLimitEndTimer = setTimeout(() => {
      sessionLimitEndTimer = null;
      if (!(voiceMode === 'tap_to_start' && tapToStartActive)) return;
      triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT);
    }, limitMs);
  }
"""
new_arm = """  function armSessionLimitTimers() {
    clearSessionLimitTimers();
    const limitMs = freeConversationSessionLimitMs;
    const warnAt = Math.max(0, limitMs - FREE_CONV_SESSION_WARNING_LEAD_MS);
    sessionLimitDeadlineAt = Date.now() + limitMs;
    sessionLimitWarnTimer = setTimeout(() => {
      sessionLimitWarnTimer = null;
      if (!(voiceMode === 'tap_to_start' && tapToStartActive)) return;
      // Do not inject the spoken warning into an active user turn or answer.
      // The visible countdown already communicates the remaining time.
      if (freeConversationUserTurnOpen || activeSources.size > 0 || DeviceVisual.getState() === 'thinking') {
        sendTelemetry('session_limit_warning_deferred', {});
        return;
      }
      speakScriptedLine(FREE_CONV_SESSION_WARNING_TEXT);
      sendTelemetry('session_limit_warning_spoken', {});
    }, warnAt);
    sessionLimitEndTimer = setTimeout(() => {
      sessionLimitEndTimer = null;
      if (!(voiceMode === 'tap_to_start' && tapToStartActive)) return;
      sessionLimitExpired = true;
      const nowMs = Date.now();
      const localSpeechBeganBeforeDeadline = Boolean(
        sessionLimitLocalSpeechStartedAt
        && sessionLimitLocalSpeechStartedAt <= sessionLimitDeadlineAt
        && sessionLimitLocalSpeechLastLoudAt
        && nowMs - sessionLimitLocalSpeechLastLoudAt <= FREE_CONV_SESSION_LOCAL_SPEECH_RECENCY_MS
      );
      // A turn that started before 0:00 is grandfathered. Let the user finish,
      // let Gemini answer fully, drain playback, then speak the closing line.
      if (freeConversationUserTurnOpen || localSpeechBeganBeforeDeadline) {
        sessionLimitFinalTurnPending = true;
        sessionLimitFinalTurnId = freeConversationUserTurnOpen ? currentTurnId : null;
        sendTelemetry('session_limit_final_turn_granted', {});
        return;
      }
      sessionLimitInputClosed = true;
      triggerAutoEnd('session_timeout', FREE_CONV_SESSION_LIMIT_TEXT);
    }, limitMs);
  }
"""
if old_arm not in dashboard:
    raise SystemExit('armSessionLimitTimers marker missing')
dashboard = dashboard.replace(old_arm, new_arm, 1)

old_vad = """      // Local barge-in: only while Free Conversation is open AND the
      // assistant is actually the one making sound right now. Hold to Talk's
      // interrupt path is pointerdown-driven (startTurn()), not this.
      if (voiceMode === 'tap_to_start' && tapToStartActive && DeviceVisual.getState() === 'speaking') {
        const confirmed = evaluateLocalVadFrame(localVadState, peak, {
          highThreshold: LOCAL_VAD_HIGH_PEAK,
          lowThreshold: LOCAL_VAD_LOW_PEAK,
          confirmFrames: LOCAL_VAD_CONFIRM_FRAMES,
        });
        if (confirmed) triggerLocalBargeIn(peak);
      }
"""
new_vad = """      // Local speech-start hint for every Free Conversation utterance.
      // Gemini still owns the authoritative end-of-speech boundary. This
      // removes dependence on provider voiceActivity being present promptly.
      if (voiceMode === 'tap_to_start' && tapToStartActive) {
        const nowMs = Date.now();
        if (peak >= LOCAL_VAD_HIGH_PEAK) {
          if (!sessionLimitLocalSpeechStartedAt) sessionLimitLocalSpeechStartedAt = nowMs;
          sessionLimitLocalSpeechLastLoudAt = nowMs;
        } else if (peak < LOCAL_VAD_LOW_PEAK
          && sessionLimitLocalSpeechLastLoudAt
          && nowMs - sessionLimitLocalSpeechLastLoudAt > FREE_CONV_SESSION_LOCAL_SPEECH_RECENCY_MS) {
          sessionLimitLocalSpeechStartedAt = 0;
          sessionLimitLocalSpeechLastLoudAt = 0;
        }
        const confirmed = evaluateLocalVadFrame(localVadState, peak, {
          highThreshold: LOCAL_VAD_HIGH_PEAK,
          lowThreshold: LOCAL_VAD_LOW_PEAK,
          confirmFrames: LOCAL_VAD_CONFIRM_FRAMES,
        });
        if (confirmed && !sessionLimitInputClosed) {
          if (DeviceVisual.getState() === 'speaking') triggerLocalBargeIn(peak);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input_audio.speech_start', source: 'client_local_vad' }));
          }
        }
      }
"""
if old_vad not in dashboard:
    raise SystemExit('local VAD marker missing')
dashboard = dashboard.replace(old_vad, new_vad, 1)

# New speech after the deadline is no longer fed to Gemini. A grandfathered
# turn keeps this flag false until its provider VAD end arrives.
replace_target = "      clientFrameCount += 1;\n      clientByteCount += pcm16.buffer.byteLength;\n      ws.send(pcm16.buffer);\n"
if dashboard.count(replace_target) != 1:
    raise SystemExit(f'audio send marker count={dashboard.count(replace_target)}')
dashboard = dashboard.replace(
    replace_target,
    "      clientFrameCount += 1;\n      clientByteCount += pcm16.buffer.byteLength;\n      if (!sessionLimitInputClosed) ws.send(pcm16.buffer);\n",
    1,
)

replace_target = "      case 'input_audio.start':\n        currentTurnId = payload.turn_id;\n"
if replace_target not in dashboard:
    raise SystemExit('input_audio.start client marker missing')
dashboard = dashboard.replace(
    replace_target,
    "      case 'input_audio.start':\n        currentTurnId = payload.turn_id;\n        inputEndedAt = 0;\n        if (voiceMode === 'tap_to_start') {\n          freeConversationUserTurnOpen = true;\n          if (sessionLimitExpired && sessionLimitFinalTurnPending && !sessionLimitFinalTurnId) {\n            sessionLimitFinalTurnId = currentTurnId;\n          }\n        }\n",
    1,
)

replace_target = "      case 'input_audio.end':\n        inputEndedAt = performance.now();\n"
if replace_target not in dashboard:
    raise SystemExit('input_audio.end client marker missing')
dashboard = dashboard.replace(
    replace_target,
    "      case 'input_audio.end':\n        inputEndedAt = performance.now();\n        if (voiceMode === 'tap_to_start') {\n          freeConversationUserTurnOpen = false;\n          if (sessionLimitFinalTurnPending\n            && (!sessionLimitFinalTurnId || sessionLimitFinalTurnId === payload.turn_id)) {\n            sessionLimitFinalTurnId = payload.turn_id || sessionLimitFinalTurnId;\n            sessionLimitInputClosed = true;\n          }\n        }\n",
    1,
)

replace_target = "      case 'audio.start':\n        // A late/reordered audio.start for a generation already cancelled\n"
if replace_target not in dashboard:
    raise SystemExit('audio.start client marker missing')
dashboard = dashboard.replace(
    replace_target,
    "      case 'audio.start':\n        if (sessionLimitFinalTurnPending\n          && sessionLimitFinalTurnId\n          && payload.turn_id === sessionLimitFinalTurnId) {\n          sessionLimitFinalTurnPending = false;\n          sessionLimitInputClosed = true;\n          clearInactivityTimers();\n          clearSessionLimitTimers();\n          pendingAutoEnd = { reason: 'session_timeout', closingText: FREE_CONV_SESSION_LIMIT_TEXT, phase: 'await_drain' };\n          sendTelemetry('auto_end_triggered', { reason: 'session_timeout', phase: 'await_drain' });\n        }\n        // A late/reordered audio.start for a generation already cancelled\n",
    1,
)

# stopFreeConversation has this exact block before the similar disconnect block.
replace_target = "    pendingAutoEnd = null;\n    tapSilenceStartedAt = null;\n    pendingTapStart = false;\n    tapToStartActive = false;\n"
if dashboard.count(replace_target) < 1:
    raise SystemExit('free-conversation teardown marker missing')
dashboard = dashboard.replace(
    replace_target,
    "    pendingAutoEnd = null;\n    tapSilenceStartedAt = null;\n    resetSessionLimitTurnState();\n    pendingTapStart = false;\n    tapToStartActive = false;\n",
    1,
)

dashboard_path.write_text(dashboard)

# 3. Remove the prompt rule that forced RAG first for almost every substantive
# question and then web after RAG miss, even when the topic was unrelated.
persona = persona_path.read_text()
section_start = persona.index('БАЗА ЗНАНИЙ И ОБЯЗАТЕЛЬНЫЙ ПОИСК')
section_end = persona.index('НЕ ОЗВУЧИВАЙ ВНУТРЕННИЕ ДЕЙСТВИЯ')
new_policy = """БАЗА ЗНАНИЙ И ПОИСК

Сначала определи, нужен ли вопросу специализированный винный факт.

Используй search_wine_knowledge, когда вопрос касается молдавского вина, конкретного вина или винодельни, сорта винограда, региона, гастропары, подачи, винного туризма, истории виноделия или другого факта, который должен быть подтверждён нашей базой.

Не запускай RAG для приветствий, благодарности, прощаний, small talk, команд интерфейса, вопросов о дате/времени и обычных общих вопросов, которые явно не требуют данных о вине. На стабильные общие вопросы отвечай прямо и кратко из общих знаний.

Не используй search_wine_knowledge как обязательный ритуал перед каждым ответом.

ВНУТРЕННИЕ И ВНЕШНИЕ ИСТОЧНИКИ: ПОЛИТИКА

Для винных фактов приоритет источников:
1. Верифицированные структурные факты (entity facts).
2. Внутренняя база знаний (KOS/RAG).
3. Внешний поиск, когда внутренних данных недостаточно, они устарели или пользователь просит актуальную проверку.

Используй внешний инструмент, когда нужны актуальные адрес, телефон, часы работы, сайт, координаты, текущая цена, наличие, расписание, официальный источник или винная сущность отсутствует во внутренней базе и без внешнего источника нельзя дать подтверждённый ответ.

Не запускай search_web автоматически после нерелевантного или бытового вопроса. Для вопроса вне винной темы не делай цепочку RAG -> web только ради проверки границ специализации.

ПРАВИЛА ВНЕШНЕГО ПОИСКА:
- Никогда не заявляй, что поиск в интернете был выполнен, если реальный инструмент не вернул результат.
- Если внешний инструмент недоступен из-за ошибки, скажи: «Сейчас внешний источник недоступен; могу ответить по внутренней базе.»
- Не выдумывай адреса, цены, наличие, винтажи, награды или технические характеристики.
- Чётко различай подтверждённые факты, неопределённые находки и отсутствующую информацию.
- Сохраняй цитаты и источник для каждого внешнего факта.
- Сохраняй контекст активной сущности между ходами разговора.

"""
persona = persona[:section_start] + new_policy + persona[section_end:]

boundary_start = persona.index('ГРАНИЦЫ СПЕЦИАЛИЗАЦИИ И РЕШЕНИЕ ОБ ОТКАЗЕ')
boundary_end = persona.index('АЛКОГОЛЬ И ЗДОРОВЬЕ')
new_boundary = """ГРАНИЦЫ СПЕЦИАЛИЗАЦИИ И РЕШЕНИЕ ОБ ОТКАЗЕ

Ты специализируешься на молдавском вине, винодельнях, сортах винограда, дегустации, гастрономических сочетаниях, винном туризме и истории молдавского виноделия.

Определи связь вопроса с этой специализацией до вызова инструментов.

Если вопрос обычный, общий и не требует свежих внешних данных, можешь ответить кратко из общих знаний без RAG и web.

Если вопрос требует глубокой экспертизы или актуальных внешних данных вне винной темы, вежливо сообщи о границе специализации. Не запускай винный RAG или web только для подтверждения того, что тема не винная.

Если в текущем разговоре уже есть явная связь события, человека или организации с винодельней, винным мероприятием или молдавской винной культурой, считай вопрос винным и используй соответствующий контекст/поиск.

Не изображай эксперта во всех темах.

"""
persona = persona[:boundary_start] + new_boundary + persona[boundary_end:]
if 'Для ЛЮБОГО содержательного вопроса' in persona or 'сначала ОБЯЗАТЕЛЬНО выполни поиск' in persona:
    raise SystemExit('mandatory RAG language remains')
persona_path.write_text(persona)

# Focused source-level regressions. Existing behavioral suites run separately.
Path('tests/freeConversationDeadlineRegression.test.js').write_text(r'''\
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
  assert.match(dashboard, /freeConversationUserTurnOpen \|\| activeSources\.size > 0 \|\| DeviceVisual\.getState\(\) === 'thinking'/);
});

test('persona does not force RAG and web for unrelated questions', () => {
  assert.doesNotMatch(persona, /Для ЛЮБОГО содержательного вопроса/);
  assert.doesNotMatch(persona, /сначала ОБЯЗАТЕЛЬНО выполни поиск/);
  assert.match(persona, /Не запускай RAG для приветствий/);
  assert.match(persona, /Не запускай search_web автоматически/);
});
''')

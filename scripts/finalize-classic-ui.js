'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dashboardPath = path.join(root, 'public', 'dashboard.html');
const controllerPath = path.join(root, 'public', 'voice-engine-ui.js');
const markerStart = '  /* WINE_AI_CLASSIC_ENGINE_UI_BEGIN */';
const markerEnd = '  /* WINE_AI_CLASSIC_ENGINE_UI_END */';
const anchor = '  // ---- WebSocket / protocol ----';

const dashboard = fs.readFileSync(dashboardPath, 'utf8');
if (dashboard.includes(markerStart)) {
  console.log('[classic-ui] dashboard integration already present');
  process.exit(0);
}
if (!dashboard.includes(anchor)) {
  throw new Error('classic_ui_anchor_not_found');
}

const controller = fs.readFileSync(controllerPath, 'utf8')
  .replace(/^'use strict';\s*/, '')
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n');

const integration = `${markerStart}\n${controller}\n\n  const voiceEngineUiController = window.WineAiVoiceEngineUi.mount({\n    getConnected() {\n      return Boolean(ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING));\n    },\n    onChange(state) {\n      const nextProvider = state.runtimeProvider;\n      const nextMode = state.conversationMode === 'open_conversation' ? 'tap_to_start' : 'hold_to_talk';\n      const providerChanged = selectedRealtimeProvider !== nextProvider;\n      const modeChanged = voiceMode !== nextMode;\n      selectedRealtimeProvider = nextProvider;\n      voiceMode = nextMode;\n      try {\n        localStorage.setItem('selectedRealtimeProvider', selectedRealtimeProvider);\n        localStorage.setItem('voiceMode', voiceMode);\n      } catch {}\n      if (typeof renderVoiceMode === 'function') renderVoiceMode();\n      if ((providerChanged || modeChanged) && ws && ws.readyState === WebSocket.OPEN) {\n        disconnect();\n      }\n    },\n  });\n\n  // Keep the engine-family controller synchronized when the detailed\n  // Realtime provider is changed later in Settings.\n  document.addEventListener('click', (event) => {\n    const option = event.target.closest('.provider-option');\n    const providerId = option?.dataset?.provider || option?.dataset?.providerId || option?.dataset?.value;\n    if (voiceEngineUiController && (providerId === 'gemini' || providerId === 'grok')) {\n      voiceEngineUiController.setRealtimeProvider(providerId);\n    }\n  });\n${markerEnd}\n\n`;

fs.writeFileSync(dashboardPath, dashboard.replace(anchor, integration + anchor));
console.log('[classic-ui] dashboard integration inserted');

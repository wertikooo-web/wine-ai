'use strict';

(function initWineAiVoiceEngineUi(global) {
  const STORAGE_KEYS = {
    engineFamily: 'wineai.engineFamily',
    conversationMode: 'wineai.conversationMode',
    realtimeProvider: 'wineai.realtimeProvider',
  };

  const ENGINE_FAMILIES = Object.freeze({
    REALTIME: 'realtime',
    CLASSIC: 'classic',
  });

  const CONVERSATION_MODES = Object.freeze({
    HOLD_TO_TALK: 'hold_to_talk',
    OPEN_CONVERSATION: 'open_conversation',
  });

  function normalizeEngineFamily(value) {
    return value === ENGINE_FAMILIES.CLASSIC ? ENGINE_FAMILIES.CLASSIC : ENGINE_FAMILIES.REALTIME;
  }

  function normalizeConversationMode(value) {
    if (value === 'tap_to_start' || value === 'free_conversation' || value === CONVERSATION_MODES.OPEN_CONVERSATION) {
      return CONVERSATION_MODES.OPEN_CONVERSATION;
    }
    return CONVERSATION_MODES.HOLD_TO_TALK;
  }

  function inferLegacyState(storage) {
    const legacyProvider = String(
      storage.getItem(STORAGE_KEYS.realtimeProvider)
      || storage.getItem('selectedRealtimeProvider')
      || storage.getItem('realtimeProvider')
      || 'gemini'
    ).toLowerCase();
    const legacyMode = storage.getItem('voiceMode') || storage.getItem('wineai.voiceMode') || 'hold_to_talk';
    return {
      engineFamily: legacyProvider === 'classic' ? ENGINE_FAMILIES.CLASSIC : ENGINE_FAMILIES.REALTIME,
      conversationMode: normalizeConversationMode(legacyMode),
      realtimeProvider: legacyProvider === 'grok' ? 'grok' : 'gemini',
    };
  }

  function loadState(storage) {
    const legacy = inferLegacyState(storage);
    return {
      engineFamily: normalizeEngineFamily(storage.getItem(STORAGE_KEYS.engineFamily) || legacy.engineFamily),
      conversationMode: normalizeConversationMode(storage.getItem(STORAGE_KEYS.conversationMode) || legacy.conversationMode),
      realtimeProvider: legacy.realtimeProvider,
    };
  }

  function saveState(storage, state) {
    storage.setItem(STORAGE_KEYS.engineFamily, normalizeEngineFamily(state.engineFamily));
    storage.setItem(STORAGE_KEYS.conversationMode, normalizeConversationMode(state.conversationMode));
    if (state.realtimeProvider) storage.setItem(STORAGE_KEYS.realtimeProvider, state.realtimeProvider);
  }

  function resolveRuntimeProvider(state) {
    return normalizeEngineFamily(state.engineFamily) === ENGINE_FAMILIES.CLASSIC
      ? 'classic'
      : (state.realtimeProvider === 'grok' ? 'grok' : 'gemini');
  }

  function createChoiceButton(document, label, value, group, selected, disabled) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'provider-option voice-engine-choice';
    button.dataset.value = value;
    button.dataset.group = group;
    button.dataset.configured = 'true';
    button.disabled = disabled === true;
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    if (selected) button.classList.add('selected');
    const name = document.createElement('span');
    name.className = 'provider-option-name';
    name.textContent = label;
    button.appendChild(name);
    return button;
  }

  function mount(options = {}) {
    const document = options.document || global.document;
    const storage = options.storage || global.localStorage;
    if (!document || !storage) return null;

    const host = document.getElementById(options.hostId || 'realtimeProviderOptions');
    if (!host) return null;

    const getConnected = options.getConnected || (() => {
      const button = document.getElementById('connectBtn');
      return Boolean(button && button.dataset.state && button.dataset.state !== 'disconnected');
    });
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    const state = loadState(storage);

    host.innerHTML = '';
    host.setAttribute('aria-label', 'Voice engine and conversation mode');

    const engineTitle = document.createElement('div');
    engineTitle.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:700;color:var(--muted);';
    engineTitle.textContent = 'Технология разговора';
    host.appendChild(engineTitle);

    const realtime = createChoiceButton(document, 'Realtime', ENGINE_FAMILIES.REALTIME, 'engine', state.engineFamily === ENGINE_FAMILIES.REALTIME);
    const classic = createChoiceButton(document, 'Classic', ENGINE_FAMILIES.CLASSIC, 'engine', state.engineFamily === ENGINE_FAMILIES.CLASSIC);
    host.append(realtime, classic);

    const modeTitle = document.createElement('div');
    modeTitle.style.cssText = 'grid-column:1/-1;font-size:12px;font-weight:700;color:var(--muted);margin-top:4px;';
    modeTitle.textContent = 'Способ общения';
    host.appendChild(modeTitle);

    const hold = createChoiceButton(document, 'Нажал, говоришь, отпустил', CONVERSATION_MODES.HOLD_TO_TALK, 'mode', state.conversationMode === CONVERSATION_MODES.HOLD_TO_TALK);
    const open = createChoiceButton(document, 'Открытый разговор', CONVERSATION_MODES.OPEN_CONVERSATION, 'mode', state.conversationMode === CONVERSATION_MODES.OPEN_CONVERSATION);
    host.append(hold, open);

    function render() {
      host.querySelectorAll('[data-group="engine"]').forEach((button) => {
        const selected = button.dataset.value === state.engineFamily;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      host.querySelectorAll('[data-group="mode"]').forEach((button) => {
        const selected = button.dataset.value === state.conversationMode;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      });
      const hint = document.getElementById('providerChoiceHint');
      if (hint) hint.textContent = state.engineFamily === ENGINE_FAMILIES.CLASSIC
        ? 'STT, текстовая модель, TTS и голос выбираются в настройках.'
        : 'Gemini Live, Grok Realtime и голос выбираются в настройках.';
    }

    function change(group, value) {
      if (getConnected()) {
        const hint = document.getElementById('providerChoiceHint');
        if (hint) hint.textContent = 'Сначала завершите текущий разговор, затем смените технологию или режим.';
        return;
      }
      if (group === 'engine') state.engineFamily = normalizeEngineFamily(value);
      if (group === 'mode') state.conversationMode = normalizeConversationMode(value);
      saveState(storage, state);
      render();
      onChange({ ...state, runtimeProvider: resolveRuntimeProvider(state) });
    }

    host.addEventListener('click', (event) => {
      const button = event.target.closest('.voice-engine-choice');
      if (!button || button.disabled) return;
      change(button.dataset.group, button.dataset.value);
    });

    saveState(storage, state);
    render();
    onChange({ ...state, runtimeProvider: resolveRuntimeProvider(state), initial: true });

    return {
      getState: () => ({ ...state, runtimeProvider: resolveRuntimeProvider(state) }),
      setRealtimeProvider(provider) {
        state.realtimeProvider = provider === 'grok' ? 'grok' : 'gemini';
        saveState(storage, state);
        onChange({ ...state, runtimeProvider: resolveRuntimeProvider(state) });
      },
      render,
    };
  }

  const api = {
    STORAGE_KEYS,
    ENGINE_FAMILIES,
    CONVERSATION_MODES,
    normalizeEngineFamily,
    normalizeConversationMode,
    inferLegacyState,
    loadState,
    saveState,
    resolveRuntimeProvider,
    mount,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.WineAiVoiceEngineUi = api;
})(typeof window !== 'undefined' ? window : globalThis);

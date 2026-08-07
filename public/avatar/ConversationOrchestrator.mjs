export const CONVERSATION_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  OPENING_TURN: 'opening_turn',
  ASSISTANT_SPEAKING: 'assistant_speaking',
  ARMING_LISTENING: 'arming_listening',
  LISTENING: 'listening',
  HOLD_READY: 'hold_ready',
  ERROR: 'error',
});

export class ConversationOrchestrator {
  constructor(adapter, options = {}) {
    if (!adapter) throw new Error('conversation_adapter_required');
    this.adapter = adapter;
    this.state = CONVERSATION_STATES.IDLE;
    this.runToken = 0;
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
  }

  setState(next, meta = {}) {
    this.state = next;
    this.onStateChange(next, meta);
  }

  cancelPending() {
    this.runToken += 1;
    this.setState(CONVERSATION_STATES.IDLE, { reason: 'cancelled' });
  }

  assertCurrent(token) {
    if (token !== this.runToken) throw new Error('conversation_start_superseded');
  }

  async start({ starter, mode } = {}) {
    const text = String(starter || '').trim();
    if (!text) throw new Error('conversation_starter_required');
    if (mode !== 'tap_to_start' && mode !== 'hold_to_talk') throw new Error('conversation_mode_invalid');

    const token = ++this.runToken;
    try {
      if (!this.adapter.isConnected()) {
        this.setState(CONVERSATION_STATES.CONNECTING, { mode });
        await this.adapter.connect();
      }
      this.assertCurrent(token);

      await this.adapter.waitForTextChannelReady();
      this.assertCurrent(token);
      this.setState(CONVERSATION_STATES.READY, { mode });

      // Critical ordering invariant: the starter is the first turn. In Free
      // Conversation we deliberately do NOT arm the microphone yet. Starting
      // continuous audio first opens a tap_to_start generation; submitting the
      // starter after that calls server startInput() again and cancels the
      // audio generation as new input. The assistant must own the first turn.
      this.setState(CONVERSATION_STATES.OPENING_TURN, { mode });
      await this.adapter.submitStarter(text);
      this.assertCurrent(token);

      await this.adapter.waitForAssistantSpeechStart();
      this.assertCurrent(token);
      this.setState(CONVERSATION_STATES.ASSISTANT_SPEAKING, { mode });

      await this.adapter.waitForAssistantSpeechDrain();
      this.assertCurrent(token);

      if (mode === 'tap_to_start') {
        this.setState(CONVERSATION_STATES.ARMING_LISTENING, { mode });
        await this.adapter.startFreeConversation();
        this.assertCurrent(token);
        await this.adapter.waitForFreeConversationActive();
        this.assertCurrent(token);
        this.setState(CONVERSATION_STATES.LISTENING, { mode });
      } else {
        await this.adapter.waitForHoldToTalkReady();
        this.assertCurrent(token);
        this.setState(CONVERSATION_STATES.HOLD_READY, { mode });
      }

      return this.state;
    } catch (error) {
      if (error?.message === 'conversation_start_superseded') return this.state;
      this.setState(CONVERSATION_STATES.ERROR, { mode, message: error?.message || String(error) });
      throw error;
    }
  }
}

function waitUntil(predicate, timeoutMs = 120000, intervalMs = 75) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      let value = null;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error('conversation_wait_timeout')); return; }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

export function createDashboardDomAdapter(document) {
  if (!document) throw new Error('document_required');
  const el = (id) => document.getElementById(id);

  return {
    isConnected() {
      return el('connectBtn')?.dataset?.state === 'connected';
    },

    async connect() {
      const button = el('connectBtn');
      if (!button) throw new Error('connect_button_missing');
      if (button.dataset.state === 'disconnected') button.click();
      await waitUntil(() => button.dataset.state === 'connected');
    },

    async waitForTextChannelReady() {
      await waitUntil(() => {
        const input = el('textInput');
        const send = el('textSendBtn');
        return input && send && !input.disabled && !send.disabled;
      });
    },

    async submitStarter(text) {
      const input = el('textInput');
      const send = el('textSendBtn');
      if (!input || !send || input.disabled || send.disabled) throw new Error('text_channel_not_ready');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      send.click();
    },

    async waitForAssistantSpeechStart() {
      const ptt = el('pttBtn');
      if (!ptt) throw new Error('ptt_button_missing');
      await waitUntil(() => ptt.classList.contains('state-speaking'));
    },

    async waitForAssistantSpeechDrain() {
      const ptt = el('pttBtn');
      if (!ptt) throw new Error('ptt_button_missing');
      await waitUntil(() => !ptt.classList.contains('state-speaking'));
    },

    async startFreeConversation() {
      const ptt = el('pttBtn');
      if (!ptt) throw new Error('ptt_button_missing');
      // This is the single legacy boundary left in the adapter. It is invoked
      // only AFTER the opening assistant turn has drained, so it can no longer
      // race the starter. The orchestrator, not the UI button, owns ordering.
      if (!this.isFreeConversationActive()) ptt.click();
    },

    isFreeConversationActive() {
      const timer = el('voiceSessionTimer');
      return Boolean(timer && timer.hidden === false);
    },

    async waitForFreeConversationActive() {
      await waitUntil(() => this.isFreeConversationActive());
    },

    async waitForHoldToTalkReady() {
      const ptt = el('pttBtn');
      if (!ptt) throw new Error('ptt_button_missing');
      await waitUntil(() => !ptt.disabled && !ptt.classList.contains('state-speaking'));
    },
  };
}

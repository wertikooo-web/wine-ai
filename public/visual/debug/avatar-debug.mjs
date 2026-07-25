'use strict';

// Standalone debug harness — NOT linked from public/dashboard.html or any
// production UI (per the explicit "don't touch production UI" constraint).
// Opens its own WebSocket to the real /realtime endpoint (same protocol
// dashboard.html uses — see public/dashboard.html's socketUrl()/
// sendSessionStart()/handleEvent()), runs every real visual.avatar.state
// event through the real adapter chain, and renders the result as plain
// text (MODE / GESTURE / MOUTH / GENERATION) instead of any character
// art. This is the "mock runtime" step of the professional build order:
//   contract -> adapter -> tests -> mock runtime -> real .riv -> art polish
// Only once this is observed stable across real questions, answers, and
// interruptions does building/wiring an actual .riv become worthwhile.

import { createAvatarSemanticAdapter } from '../avatarSemanticAdapter.mjs';
import { AvatarCommandRuntime, createDebugInputAdapter } from '../riveAvatarAdapter.mjs';

const logEl = document.getElementById('log');
const stateEl = document.getElementById('state');
const statusEl = document.getElementById('status');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const interruptBtn = document.getElementById('interruptBtn');

function log(line) {
    const time = new Date().toISOString().split('T')[1].replace('Z', '');
    logEl.textContent = `[${time}] ${line}\n` + logEl.textContent;
}

function renderState(state) {
    stateEl.textContent =
        `MODE:       ${state.mode}\n` +
        `GESTURE:    ${state.gesture}\n` +
        `EMOTION:    ${state.emotion}\n` +
        `MOUTH:      ${state.mouth}\n` +
        `BLINKS:     ${state.blinkCount}\n` +
        `GENERATION: ${currentGenerationId || '(none)'}`;
}

let ws = null;
let currentGenerationId = null;

const adapter = createAvatarSemanticAdapter({ log: (event, data) => log(`adapter: ${event} ${JSON.stringify(data)}`) });
const inputAdapter = createDebugInputAdapter(renderState);
const runtime = new AvatarCommandRuntime(inputAdapter);
renderState(inputAdapter.getState());

function socketUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/realtime`;
}

function connect() {
    statusEl.textContent = 'connecting…';
    ws = new WebSocket(socketUrl());
    ws.addEventListener('open', () => {
        statusEl.textContent = 'connected';
        ws.send(JSON.stringify({ type: 'session.start', sampleRate: 16000 }));
        log('ws open, session.start sent');
    });
    ws.addEventListener('close', () => { statusEl.textContent = 'disconnected'; log('ws closed'); });
    ws.addEventListener('error', () => { statusEl.textContent = 'error'; log('ws error'); });
    ws.addEventListener('message', (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        handleEvent(payload);
    });
}

function handleEvent(payload) {
    if (payload.generation_id) currentGenerationId = payload.generation_id;

    if (String(payload.type || '').startsWith('visual.')) {
        log(`visual event: ${payload.type} (gen=${payload.generationId || payload.generation_id || '?'})`);
        const command = adapter.translate(payload);
        if (command) {
            runtime.apply(command);
        } else if (payload.type === 'visual.reset' || payload.type === 'visual.timeline.cancel') {
            // Not an avatar-command-bearing event itself, but a clear
            // signal to release the runtime's generation claim so the
            // NEXT generation's commands aren't silently ignored as stale.
            if (payload.generationId) runtime.endGeneration(payload.generationId);
        }
        return;
    }

    if (payload.type === 'response.cancelled' || payload.type === 'response.failed') {
        if (payload.generation_id) runtime.endGeneration(payload.generation_id);
        log(`turn ended: ${payload.type}`);
    }
    if (payload.type === 'audio.end') {
        log('audio.end (turn likely complete — visual.timeline.complete should follow)');
    }
}

function sendText() {
    const text = textInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    log(`-> input_text.submit: "${text}"`);
    ws.send(JSON.stringify({ type: 'input_text.submit', text }));
    textInput.value = '';
}

sendBtn.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
interruptBtn.addEventListener('click', () => {
    // Per public/dashboard.html's own comments: submitting a new
    // input_text.submit while a reply is in progress interrupts it
    // server-side (same mechanism PTT barge-in uses) — no separate
    // "cancel" message type exists to send explicitly.
    textInput.value = textInput.value || 'Расскажи про другое вино';
    sendText();
    log('(sent as an interruption — server cancels the in-flight generation)');
});

connect();

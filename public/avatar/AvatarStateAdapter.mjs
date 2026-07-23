const STATE_MAP = Object.freeze({
  disconnected: 'unavailable', connecting: 'idle', ready: 'idle',
  listening: 'listening', thinking: 'thinking', speaking: 'talking',
  presenting: 'presenting', error: 'error',
});

export function toAvatarState(deviceState) {
  return STATE_MAP[deviceState] || 'idle';
}

export function isSpeakingState(deviceState) {
  return toAvatarState(deviceState) === 'talking';
}

export { STATE_MAP };

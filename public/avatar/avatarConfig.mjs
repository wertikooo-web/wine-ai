const LOCAL_DEFAULTS = Object.freeze({
  enabled: true,
  modelType: 'procedural',
  modelUrl: '',
  lipSync: { sensitivity: 3.4, noiseGate: 0.018, attack: 0.42, release: 0.16 },
  performance: { maxPixelRatio: 1.5 },
});

export async function loadAvatarConfig() {
  try {
    const response = await fetch('/api/avatar/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`avatar_config_${response.status}`);
    const remote = await response.json();
    return {
      ...LOCAL_DEFAULTS,
      ...remote,
      lipSync: { ...LOCAL_DEFAULTS.lipSync, ...(remote.lipSync || {}) },
      performance: { ...LOCAL_DEFAULTS.performance, ...(remote.performance || {}) },
    };
  } catch {
    return LOCAL_DEFAULTS;
  }
}

export { LOCAL_DEFAULTS };

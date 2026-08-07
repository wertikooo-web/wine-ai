import { START_INTENT_STORAGE_KEY } from './StartIntentLauncher.mjs';

function safeParse(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasSettings(settings) {
  return Boolean(settings && typeof settings === 'object' && Object.keys(settings).length);
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function profileIds() {
  try {
    const result = await fetchJson('/api/persona/profiles');
    const ids = (result.profiles || []).map((profile) => profile.id).filter(Boolean);
    if (ids.length) return ids;
  } catch {}
  return ['classic', 'warm_guide'];
}

async function persistToProfiles(settings) {
  const ids = await profileIds();
  await Promise.all(ids.map((profileId) => fetchJson('/api/persona', {
    method: 'POST',
    body: JSON.stringify({ profileId, overrides: { startIntents: settings } }),
  })));
  return settings;
}

export async function createServerBackedStartIntentStorage(options = {}) {
  const local = options.localStorage || globalThis.localStorage;
  let pending = Promise.resolve();
  let lastError = null;

  const storage = {
    getItem(key) {
      return local?.getItem?.(key) ?? null;
    },
    setItem(key, value) {
      local?.setItem?.(key, value);
      if (key !== START_INTENT_STORAGE_KEY) return;
      const settings = safeParse(value);
      pending = pending
        .catch(() => {})
        .then(() => persistToProfiles(settings))
        .then(() => {
          lastError = null;
          globalThis.dispatchEvent?.(new CustomEvent('wineai:start-intents-persisted', { detail: { ok: true } }));
        })
        .catch((error) => {
          lastError = error;
          console.warn('[WineAI] Failed to persist start intents:', error?.message || error);
          globalThis.dispatchEvent?.(new CustomEvent('wineai:start-intents-persisted', { detail: { ok: false, error: error?.message || String(error) } }));
        });
    },
    removeItem(key) {
      local?.removeItem?.(key);
      if (key === START_INTENT_STORAGE_KEY) this.setItem(key, '{}');
    },
    async flush() {
      await pending;
      if (lastError) throw lastError;
    },
    getLastError() {
      return lastError;
    },
  };

  const localSettings = safeParse(local?.getItem?.(START_INTENT_STORAGE_KEY));
  try {
    const persona = await fetchJson('/api/persona');
    const serverSettings = persona?.overrides?.startIntents;
    if (hasSettings(serverSettings)) {
      local?.setItem?.(START_INTENT_STORAGE_KEY, JSON.stringify(serverSettings));
    } else if (hasSettings(localSettings)) {
      await persistToProfiles(localSettings);
    } else {
      local?.setItem?.(START_INTENT_STORAGE_KEY, '{}');
    }
  } catch (error) {
    lastError = error;
    console.warn('[WineAI] Start intent server hydration failed; using local fallback:', error?.message || error);
  }

  return storage;
}

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

async function persistToProfiles(settings, ids = null) {
  const targets = ids || await profileIds();
  await Promise.all(targets.map((profileId) => fetchJson('/api/persona', {
    method: 'POST',
    body: JSON.stringify({ profileId, overrides: { startIntents: settings } }),
  })));
  return settings;
}

async function readServerSettings(ids) {
  for (const profileId of ids) {
    try {
      const persona = await fetchJson(`/api/persona?profileId=${encodeURIComponent(profileId)}`);
      const settings = persona?.overrides?.startIntents;
      if (hasSettings(settings)) return settings;
    } catch (error) {
      if (error?.status === 400) continue;
      throw error;
    }
  }
  return {};
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
    const ids = await profileIds();
    const serverSettings = await readServerSettings(ids);
    if (hasSettings(serverSettings)) {
      local?.setItem?.(START_INTENT_STORAGE_KEY, JSON.stringify(serverSettings));
      // Keep the setting global from the operator's perspective even though
      // the existing persona store persists JSONB per profile.
      await persistToProfiles(serverSettings, ids);
    } else if (hasSettings(localSettings)) {
      // One-time migration from the browser-local v1 editor to PostgreSQL.
      await persistToProfiles(localSettings, ids);
    } else {
      local?.setItem?.(START_INTENT_STORAGE_KEY, '{}');
    }
  } catch (error) {
    lastError = error;
    console.warn('[WineAI] Start intent server hydration failed; using local fallback:', error?.message || error);
  }

  return storage;
}

'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentPersistence.mjs')).href;
  const launcherUrl = pathToFileURL(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentLauncher.mjs')).href;
  const { START_INTENT_STORAGE_KEY } = await import(launcherUrl);

  const localMap = new Map([[START_INTENT_STORAGE_KEY, JSON.stringify({ ru: { pair_food: { label: 'Локально' } } })]]);
  const localStorage = {
    getItem: (key) => localMap.has(key) ? localMap.get(key) : null,
    setItem: (key, value) => localMap.set(key, value),
    removeItem: (key) => localMap.delete(key),
  };

  const requests = [];
  global.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  global.dispatchEvent = () => true;
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url === '/api/persona/profiles') {
      return { ok: true, json: async () => ({ ok: true, profiles: [{ id: 'classic' }, { id: 'warm_guide' }] }) };
    }
    if (String(url).startsWith('/api/persona?profileId=')) {
      return { ok: true, json: async () => ({ ok: true, overrides: {} }) };
    }
    if (url === '/api/persona' && options.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const { createServerBackedStartIntentStorage } = await import(`${moduleUrl}?v=1`);
  const storage = await createServerBackedStartIntentStorage({ localStorage });

  // No server value existed, so the old browser-local settings must migrate
  // to every persona row in the server-side PostgreSQL-backed store.
  const migrationPosts = requests.filter((request) => request.url === '/api/persona' && request.options.method === 'POST');
  assert.strictEqual(migrationPosts.length, 2);
  for (const request of migrationPosts) {
    const body = JSON.parse(request.options.body);
    assert(body.overrides.startIntents.ru.pair_food.label === 'Локально');
  }

  requests.length = 0;
  storage.setItem(START_INTENT_STORAGE_KEY, JSON.stringify({ en: { choose_wine: { label: 'Pick wine' } } }));
  await storage.flush();
  const savePosts = requests.filter((request) => request.url === '/api/persona' && request.options.method === 'POST');
  assert.strictEqual(savePosts.length, 2);
  assert(savePosts.every((request) => JSON.parse(request.options.body).overrides.startIntents.en.choose_wine.label === 'Pick wine'));

  console.log('startIntentPersistence.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

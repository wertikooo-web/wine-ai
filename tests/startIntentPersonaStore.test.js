'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-ai-start-intents-'));
  const file = path.join(dir, 'persona-overrides.json');
  process.env.PERSONA_OVERRIDES_FILE = file;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  const store = require('../src/persona/personaStore');
  await store.load();

  const startIntents = {
    ru: {
      pair_food: {
        label: 'К блюду',
        openingLine: 'Что сегодня будете есть?',
        context: 'Подбери вино к блюду.',
        enabled: true,
      },
    },
  };

  await store.updateProfile('classic', { startIntents });
  assert.deepStrictEqual(store.getProfilesOverrides().classic.overrides.startIntents, startIntents);

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(persisted.profiles.classic.overrides.startIntents, startIntents);

  await assert.rejects(
    () => store.updateProfile('classic', { startIntents: { xx: { pair_food: { label: 'bad' } } } }),
    /invalid_start_intent_language/
  );
  await assert.rejects(
    () => store.updateProfile('classic', { startIntents: { ru: { bad_intent: { label: 'bad' } } } }),
    /invalid_start_intent_id/
  );
  await assert.rejects(
    () => store.updateProfile('classic', { startIntents: { ru: { pair_food: { unknown: true } } } }),
    /invalid_start_intent_field/
  );

  await store.updateProfile('classic', { startIntents: null });
  assert.strictEqual(store.getProfilesOverrides().classic.overrides.startIntents, undefined);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('startIntentPersonaStore.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

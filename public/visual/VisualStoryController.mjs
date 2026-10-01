import { mountStartIntentLauncher } from '/avatar-modules/StartIntentLauncher.mjs';
import { mountStartIntentSettings } from '/avatar-modules/StartIntentSettings.mjs';
import { createServerBackedStartIntentStorage } from '/avatar-modules/StartIntentPersistence.mjs';
export * from '/avatar-modules/VisualStoryControllerCore.mjs';

const publicMode = /^\/lite\/?$/.test(globalThis.location?.pathname || '')
  || new URLSearchParams(globalThis.location?.search || '').get('lite') === '1';
const startIntentStorage = await createServerBackedStartIntentStorage({ publicMode });
mountStartIntentLauncher({ storage: startIntentStorage, publicMode });
mountStartIntentSettings({ storage: startIntentStorage });

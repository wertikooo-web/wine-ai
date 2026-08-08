import { mountStartIntentLauncher } from '/avatar-modules/StartIntentLauncher.mjs';
import { mountStartIntentSettings } from '/avatar-modules/StartIntentSettings.mjs';
import { createServerBackedStartIntentStorage } from '/avatar-modules/StartIntentPersistence.mjs';
export * from '/avatar-modules/VisualStoryControllerCore.mjs';

const startIntentStorage = await createServerBackedStartIntentStorage();
mountStartIntentLauncher({ storage: startIntentStorage });
mountStartIntentSettings({ storage: startIntentStorage });

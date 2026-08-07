'use strict';

const fs = require('fs');
const path = require('path');

const dashboard = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
const settingsModule = fs.readFileSync(path.join(__dirname, '..', 'public', 'avatar', 'StartIntentSettings.mjs'), 'utf8');

if (!dashboard.includes('data-tab="persona"')) {
  throw new Error('dashboard must expose the Settings tab as persona');
}
if (!dashboard.includes('id="tab-persona"')) {
  throw new Error('dashboard must contain #tab-persona settings panel');
}
if (!settingsModule.includes("getElementById('tab-persona')")) {
  throw new Error('StartIntentSettings must mount into #tab-persona');
}
if (settingsModule.includes("getElementById('tab-settings')")) {
  throw new Error('StartIntentSettings still references stale #tab-settings selector');
}

console.log('startIntentSettingsMount.test.js: OK');

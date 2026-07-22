'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readProjectFile(...parts) {
    return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

function run() {
    const dashboard = readProjectFile('public', 'dashboard.html');
    const lab = readProjectFile('public', 'avatar-dev.html');
    const server = readProjectFile('src', 'server.js');
    let assertionCount = 0;

    assert.match(dashboard, /<img(?: class="avatar-fallback")? src="\/avatar\.png"/); assertionCount += 1;
    assert.doesNotMatch(dashboard, /^\s*initAvatar3d\(\);\s*$/m); assertionCount += 1;
    assert.match(dashboard, /href="\/avatar-lab" target="_blank" rel="noopener"/); assertionCount += 1;
    assert.match(server, /pathname === '\/avatar-lab'/); assertionCount += 1;
    assert.match(lab, /id="avatarCatalog"/); assertionCount += 1;
    assert.match(lab, /id="avatarFile"[^>]+\.jpg,[^>]+\.vrm/); assertionCount += 1;
    assert.match(lab, /indexedDB\.open\('wine-ai-avatar-lab'/); assertionCount += 1;
    assert.match(lab, /Dashboard и исходная статичная картинка не меняются/); assertionCount += 1;

    return { assertionCount };
}

module.exports = { run };

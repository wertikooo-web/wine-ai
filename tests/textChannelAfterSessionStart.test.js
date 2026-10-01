'use strict';

// Regression: the text channel (which start cards use) must open only after
// session.start was sent. Enabling it on WebSocket open let a start card
// submit its starter while the mic was still being acquired; the turn then
// ran on the default prompt/voice and the late session.start was rejected
// with session_config_busy, flashing "Error" above the cards.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function run() {
    let n = 0;
    const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
    const openStart = source.indexOf("socket.addEventListener('open'");
    const openEnd = source.indexOf("socket.addEventListener('close'", openStart);
    ok(openStart >= 0 && openEnd > openStart, 'ws open handler found');
    const handler = source.slice(openStart, openEnd);
    const sessionStartAt = handler.indexOf('sendSessionStart();');
    ok(sessionStartAt >= 0, 'open handler sends session.start');
    for (const id of ['textInput', 'textSendBtn', 'langSelect']) {
        const enableAt = handler.indexOf(`el('${id}').disabled = false`);
        ok(enableAt > sessionStartAt, `${id} is enabled only after session.start`);
        ok(handler.indexOf(`el('${id}').disabled = false`, enableAt + 1) < 0, `${id} is enabled once`);
    }
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`textChannelAfterSessionStart passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

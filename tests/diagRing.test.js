'use strict';

// Admin diagnostic ring (src/realtime/diagRing.js): bounded, newest last.
const t = require('./helpers/assertions');
const diagRing = require('../src/realtime/diagRing');

async function run() {
    for (let i = 0; i < 230; i += 1) diagRing.push('gemini_connect', { n: i, languageCode: i % 2 ? 'ru-RU' : null });
    const all = diagRing.recent();
    t.equal(all.length, 200, 'bounded to 200 entries');
    t.equal(all[all.length - 1].n, 229, 'newest last');
    t.ok(all.every((e) => e.at && e.type === 'gemini_connect'), 'timestamp + type on every entry');
    t.equal(diagRing.recent(5).length, 5, 'limit');
    return { assertionCount: 4 };
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('diagRing tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

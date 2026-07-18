'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SMOKE_SCRIPTS = ['http-smoke.js', 'realtime-smoke.js', 'knowledge-smoke.js', 'language-smoke.js'];

let failed = 0;
for (const script of SMOKE_SCRIPTS) {
    console.log(`\n=== ${script} ===`);
    const result = spawnSync(process.execPath, [path.join(__dirname, script)], { stdio: 'inherit', env: process.env });
    if (result.status !== 0) failed += 1;
}

console.log(`\n${SMOKE_SCRIPTS.length - failed}/${SMOKE_SCRIPTS.length} smoke scripts passed`);
process.exit(failed > 0 ? 1 : 0);

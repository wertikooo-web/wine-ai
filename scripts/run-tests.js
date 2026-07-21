'use strict';

// No test framework dependency — plain Node scripts under tests/*.test.js,
// each exporting async run(). Matches the origin project's own convention
// (see docs/WINE_AI_MIGRATION_PLAN.md section 1.20) of standalone smoke
// scripts rather than a framework; unlike those, these use Node's built-in
// assert module for real pass/fail signal instead of console.log-and-hope.
const fs = require('fs');
const path = require('path');

const testsDir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort();
const PER_FILE_TIMEOUT_MS = 20000;

if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = 'memory';
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — likely a hung socket/promise, not a slow assertion`)), ms)),
    ]);
}

async function main() {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const startedAt = Date.now();

    for (const file of files) {
        const fullPath = path.join(testsDir, file);
        const fileStartedAt = Date.now();
        try {
            delete require.cache[fullPath];
            const mod = require(fullPath);
            let wasSkipped = false;
            let assertionCount = 0;

            const origLog = console.log;
            console.log = (...args) => {
                const line = args.join(' ');
                if (line.startsWith('skip:')) {
                    wasSkipped = true;
                }
                origLog(...args);
            };

            try {
                if (typeof mod.run === 'function') {
                    const testResult = await withTimeout(mod.run(), PER_FILE_TIMEOUT_MS, file);
                    if (testResult && typeof testResult.assertionCount === 'number') {
                        assertionCount = testResult.assertionCount;
                    }
                }
            } finally {
                console.log = origLog;
            }

            if (wasSkipped) {
                console.log(`[STATUS: SKIP] ${file}`);
                skipped += 1;
            } else {
                const assertStr = assertionCount > 0 ? `, ${assertionCount} assertion(s)` : '';
                console.log(`[STATUS: OK]   ${file}${assertStr}`);
                passed += 1;
            }
        } catch (error) {
            console.log(`[STATUS: FAIL] ${file}`);
            console.error(`\n============================`);
            console.error(`FAIL IN FILE: ${file}`);
            console.error(`Error Code: ${error.code}`);
            console.error(`Error Message: ${error.message}`);
            console.error(error.stack);
            console.error(`============================\n`);
            failed += 1;
        }
    }

    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, ${files.length} total (${Date.now() - startedAt}ms)`);
    process.exit(failed > 0 ? 1 : 0);
}

main();

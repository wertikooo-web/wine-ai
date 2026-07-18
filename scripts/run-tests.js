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

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms — likely a hung socket/promise, not a slow assertion`)), ms)),
    ]);
}

async function main() {
    let passed = 0;
    let failed = 0;
    const startedAt = Date.now();

    for (const file of files) {
        const fullPath = path.join(testsDir, file);
        const fileStartedAt = Date.now();
        try {
            const mod = require(fullPath);
            await withTimeout(mod.run(), PER_FILE_TIMEOUT_MS, file);
            console.log(`ok   ${file} (${Date.now() - fileStartedAt}ms)`);
            passed += 1;
        } catch (error) {
            console.error(`FAIL ${file} (${Date.now() - fileStartedAt}ms)`);
            console.error(`     ${error.message}`);
            if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
            failed += 1;
        }
    }

    console.log(`\n${passed} passed, ${failed} failed, ${files.length} total (${Date.now() - startedAt}ms)`);
    // Explicit exit rather than letting the event loop drain naturally — a
    // timed-out test may have left a server/socket handle open, which would
    // otherwise hang this whole script forever even after results are in.
    process.exit(failed > 0 ? 1 : 0);
}

main();

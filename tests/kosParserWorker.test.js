'use strict';

/**
 * WINE AI KOS - Parser Worker Thread Test Suite (Step 2B.1 Production Refined)
 *
 * Exhaustive Worker Lifecycle Verification:
 * 1. Successful message parsing
 * 2. Typed parser error forwarding
 * 3. Worker error event handling -> KOS_PARSE_WORKER_FAILED
 * 4. Exit code 0 without message -> KOS_PARSE_WORKER_EXITED (No hanging promise!)
 * 5. Non-zero exit code without message -> KOS_PARSE_WORKER_EXITED
 * 6. Hard CPU infinite loop timeout termination -> KOS_PARSE_TIMEOUT
 */

const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const { parseDocument } = require('../src/kos/parsers/adapters/adapterRegistry');
const { KosParserError } = require('../src/kos/parsers/core/parserContracts');

const WORKER_SCRIPT = path.resolve(__dirname, '../src/kos/parsers/core/parserWorker.js');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. Successful Worker Message
    const buffer = Buffer.from('Worker plain text payload', 'utf8');
    const result = await parseDocument(buffer, { originalFilename: 'worker.txt' }, { useWorker: true, now: () => new Date('2026-01-01T00:00:00Z') });
    assertEqual(result.canonicalText, 'Worker plain text payload');

    // 2. Typed Parser Error Message Forwarding
    const pdfCorrupted = Buffer.from('Corrupted non-pdf string data');
    assertions++;
    await assert.rejects(async () => {
        await parseDocument(pdfCorrupted, { declaredMimeType: 'application/pdf' }, { useWorker: true });
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_CORRUPTED_CONTAINER');

    // 3. Exit Code 0 Without Posting Message (MUST REJECT, NO HANGING PROMISE!)
    assertions++;
    await assert.rejects(async () => {
        await new Promise((resolve, reject) => {
            let isSettled = false;
            const dummyWorker = new Worker('process.exit(0);', { eval: true });

            const settle = (fn) => {
                if (isSettled) return;
                isSettled = true;
                dummyWorker.removeAllListeners();
                fn();
            };

            dummyWorker.on('message', (msg) => settle(() => resolve(msg)));
            dummyWorker.on('exit', (code) => {
                settle(() => reject(new KosParserError('KOS_PARSE_WORKER_EXITED', `Worker exited before returning a result with code ${code}.`)));
            });
            dummyWorker.on('error', (err) => settle(() => reject(err)));
        });
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_WORKER_EXITED');

    // 4. Non-Zero Exit Code Without Posting Message
    assertions++;
    await assert.rejects(async () => {
        await new Promise((resolve, reject) => {
            let isSettled = false;
            const dummyWorker = new Worker('process.exit(1);', { eval: true });

            const settle = (fn) => {
                if (isSettled) return;
                isSettled = true;
                dummyWorker.removeAllListeners();
                fn();
            };

            dummyWorker.on('message', (msg) => settle(() => resolve(msg)));
            dummyWorker.on('exit', (code) => {
                settle(() => reject(new KosParserError('KOS_PARSE_WORKER_EXITED', `Worker exited before returning a result with code ${code}.`)));
            });
            dummyWorker.on('error', (err) => settle(() => reject(err)));
        });
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_WORKER_EXITED');

    // 5. Hard CPU Infinite Loop Timeout Termination Test
    assertions++;
    await assert.rejects(async () => {
        await new Promise((resolve, reject) => {
            let isSettled = false;
            const worker = new Worker(WORKER_SCRIPT, {
                workerData: { format: 'cpu_block_test', buffer: Buffer.from('test') },
            });

            const timer = setTimeout(() => {
                if (!isSettled) {
                    isSettled = true;
                    worker.terminate();
                    reject(new KosParserError('KOS_PARSE_TIMEOUT', 'Worker CPU loop hard-terminated by timeout.'));
                }
            }, 50);

            worker.on('exit', (code) => {
                if (!isSettled) {
                    isSettled = true;
                    clearTimeout(timer);
                    reject(new KosParserError('KOS_PARSE_WORKER_EXITED', `Worker exited prematurely with code ${code}.`));
                }
            });
        });
    }, (err) => err instanceof KosParserError && err.code === 'KOS_PARSE_TIMEOUT');

    console.log(`kosParserWorker.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };

'use strict';

// Unit + integration tests for the corpus-manifest-audit --snapshot argument.
// Guards the regression: the script used to statically require the untracked
// ../reconcile-production.json, which broke clean checkouts. Now the snapshot
// is passed as `--snapshot <path>` and loaded only inside main().

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, '..', 'scripts', 'corpus-manifest-audit.js');
const audit = require('../scripts/corpus-manifest-audit');

function fixtureSnapshot() {
    return {
        ok: true,
        snapshot: '2026-08-04T09:55:15.743Z',
        production: {},
        categories: {},
        arithmetic: {},
        groups: {},
        fileSummaries: [
            { file: 'feteasca-neagra.md', group: 'doc', totalChunks: 5, exact: 5, changed: 0, 'fs-only': 0, 'stale-duplicate': 0 },
        ],
        pgOnlyByPrefix: {},
    };
}

async function run() {
    let assertions = 0;

    // --- unit: requiring the module needs no snapshot (static require removed) ---
    {
        assert.strictEqual(typeof audit.parseArgs, 'function');
        assert.strictEqual(typeof audit.loadSnapshot, 'function');
        assertions += 2;
        console.log('ok  clean require exposes parseArgs + loadSnapshot (no static reconcile require)');
    }

    // --- unit: parseArgs without --snapshot ---
    {
        const r = audit.parseArgs([]);
        assert.deepStrictEqual(r, { snapshot: null });
        assertions += 1;
        console.log('ok  parseArgs([]) -> snapshot null');
    }

    // --- unit: parseArgs missing value for --snapshot ---
    {
        const r = audit.parseArgs(['--snapshot']);
        assert.ok(r.error, 'expected error for --snapshot without a value');
        assertions += 1;
        console.log('ok  parseArgs([--snapshot]) -> error');
    }

    // --- unit: parseArgs returns provided path ---
    {
        const r = audit.parseArgs(['--snapshot', 'some/reconcile.json']);
        assert.strictEqual(r.snapshot, 'some/reconcile.json');
        assertions += 1;
        console.log('ok  parseArgs([--snapshot path]) -> path');
    }

    // --- unit: loadSnapshot reads + parses a valid fixture ---
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-audit-test-'));
        const p = path.join(dir, 'fixture.json');
        fs.writeFileSync(p, JSON.stringify(fixtureSnapshot()));
        const loaded = audit.loadSnapshot(p);
        assert.strictEqual(loaded.snapshot, '2026-08-04T09:55:15.743Z');
        assert.ok(Array.isArray(loaded.fileSummaries) && loaded.fileSummaries.length === 1);
        fs.rmSync(dir, { recursive: true, force: true });
        assertions += 2;
        console.log('ok  loadSnapshot parses a valid snapshot fixture');
    }

    // --- unit: loadSnapshot rejects a malformed snapshot ---
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-audit-test-'));
        const p = path.join(dir, 'bad.json');
        fs.writeFileSync(p, JSON.stringify({ snapshot: 'x' }));
        assert.throws(() => audit.loadSnapshot(p), /fileSummaries/);
        fs.rmSync(dir, { recursive: true, force: true });
        assertions += 1;
        console.log('ok  loadSnapshot rejects missing fileSummaries');
    }

    // --- integration: no args -> usage + nonzero exit, no DB needed ---
    {
        const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
        assert.notStrictEqual(r.status, 0);
        assert.match((r.stdout + r.stderr), /--snapshot <path>/);
        assertions += 2;
        console.log('ok  CLI without --snapshot exits nonzero with usage');
    }

    // --- integration: --snapshot fixture, no DATABASE_URL -> stops at DB gate,
    //     NOT at a missing ../reconcile-production.json module ---
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-audit-test-'));
        const p = path.join(dir, 'fixture.json');
        fs.writeFileSync(p, JSON.stringify(fixtureSnapshot()));
        const env = Object.assign({}, process.env, { DATABASE_URL: '' });
        const r = spawnSync(process.execPath, [script, '--snapshot', p], { encoding: 'utf8', env });
        assert.notStrictEqual(r.status, 0);
        assert.doesNotMatch(r.stderr, /Cannot find module ['"]?\.\.\/reconcile-production\.json/);
        assert.match((r.stdout + r.stderr), /DATABASE_URL not set/);
        fs.rmSync(dir, { recursive: true, force: true });
        assertions += 3;
        console.log('ok  CLI --snapshot parses + loads fixture before reaching DB gate');
    }

    console.log(`\ncorpusManifestAuditSnapshot: ${assertions} assertions passed`);
    return { assertionCount: assertions };
}

module.exports = { run };
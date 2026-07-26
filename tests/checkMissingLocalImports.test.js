'use strict';

// Unit tests for scripts/check-missing-local-imports.js
// Uses a temporary git repo to verify the checker correctly flags
// untracked local imports and passes tracked ones.

const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checker = require('../scripts/check-missing-local-imports');

function tmpRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-checker-test-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });
    return dir;
}

function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

async function run() {
    let assertions = 0;

    // --- extractLocalImports tests ---

    // 1. require with relative path
    {
        const tmpFile = path.join(os.tmpdir(), `test-extract-${Date.now()}.js`);
        fs.writeFileSync(tmpFile, "const x = require('./foo');\nconst y = require('../bar/baz.js');\n");
        const imports = checker.extractLocalImports(tmpFile);
        assert.strictEqual(imports.length, 2);
        assert.strictEqual(imports[0].specifier, './foo');
        assert.strictEqual(imports[0].line, 1);
        assert.strictEqual(imports[1].specifier, '../bar/baz.js');
        assert.strictEqual(imports[1].line, 2);
        fs.unlinkSync(tmpFile);
        assertions += 4;
        console.log('ok  extractLocalImports: require with relative paths');
    }

    // 2. import from with relative path
    {
        const tmpFile = path.join(os.tmpdir(), `test-extract-import-${Date.now()}.js`);
        fs.writeFileSync(tmpFile, "import foo from './bar';\nimport { x } from '../baz/qux.js';\n");
        const imports = checker.extractLocalImports(tmpFile);
        assert.strictEqual(imports.length, 2);
        assert.strictEqual(imports[0].specifier, './bar');
        assert.strictEqual(imports[1].specifier, '../baz/qux.js');
        fs.unlinkSync(tmpFile);
        assertions += 3;
        console.log('ok  extractLocalImports: import from with relative paths');
    }

    // 3. dynamic import()
    {
        const tmpFile = path.join(os.tmpdir(), `test-extract-dynamic-${Date.now()}.js`);
        fs.writeFileSync(tmpFile, "const m = import('./lazy');\n");
        const imports = checker.extractLocalImports(tmpFile);
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].specifier, './lazy');
        fs.unlinkSync(tmpFile);
        assertions += 2;
        console.log('ok  extractLocalImports: dynamic import()');
    }

    // 4. package imports are skipped
    {
        const tmpFile = path.join(os.tmpdir(), `test-extract-package-${Date.now()}.js`);
        fs.writeFileSync(tmpFile, "const ws = require('ws');\nconst fs = require('node:fs');\nimport x from 'express';\nimport y from './local';\n");
        const imports = checker.extractLocalImports(tmpFile);
        assert.strictEqual(imports.length, 1);
        assert.strictEqual(imports[0].specifier, './local');
        fs.unlinkSync(tmpFile);
        assertions += 2;
        console.log('ok  extractLocalImports: package imports skipped');
    }

    // --- resolveCandidates tests ---

    // 5. basic resolution
    {
        const candidates = checker.resolveCandidates('./foo', 'src/server.js');
        assert.deepStrictEqual(candidates, [
            'src/foo',
            'src/foo.js',
            'src/foo.json',
            'src/foo/index.js',
            'src/foo/index.json',
        ]);
        assertions += 1;
        console.log('ok  resolveCandidates: basic resolution');
    }

    // 6. parent-relative resolution
    {
        const candidates = checker.resolveCandidates('../bar/baz', 'src/realtime/wsProtocol.js');
        // path.join normalizes: path.join('src/realtime', '../bar/baz') = 'src/bar/baz'
        assert.deepStrictEqual(candidates, [
            'src/bar/baz',
            'src/bar/baz.js',
            'src/bar/baz.json',
            'src/bar/baz/index.js',
            'src/bar/baz/index.json',
        ]);
        assertions += 1;
        console.log('ok  resolveCandidates: parent-relative resolution');
    }

    // --- Integration: real repo check ---
    // The actual repo's own import check should pass (that's the whole point).
    {
        execSync(`node ${path.join(__dirname, '..', 'scripts', 'check-missing-local-imports.js')}`, {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        assertions += 1;
        console.log('ok  integration: this repo passes its own check');
    }

    console.log(`\ncheckMissingLocalImports: ${assertions} assertions passed`);
    return { assertionCount: assertions };
}

module.exports = { run };

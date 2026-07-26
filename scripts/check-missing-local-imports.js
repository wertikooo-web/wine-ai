'use strict';

// Scans committed project JS files for local relative require()/import
// statements and verifies each target is tracked by Git.
// Catches the class of bug where src/auth/adminAuth.js existed on the
// developer's machine but was never committed — the server would crash
// with MODULE_NOT_FOUND in any clean checkout (CI, Railway, fresh clone).
//
// Usage:  node scripts/check-missing-local-imports.js
// Exit 0: all local imports resolve to tracked files.
// Exit 1: at least one local import references a file not in Git.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------
// Get all JS/MJS files tracked by Git
// ---------------------------------------------------------------
function getTrackedFiles() {
    const raw = execSync('git ls-files "*.js" "*.mjs"', {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------
// Build a Set of all tracked file paths (relative to ROOT) for O(1) lookup
// ---------------------------------------------------------------
function getTrackedSet(files) {
    const set = new Set();
    for (const f of files) {
        set.add(f);
        // Also add with forward slashes (POSIX) for cross-platform matching
        set.add(f.split(path.sep).join('/'));
    }
    return set;
}

// ---------------------------------------------------------------
// Extract local relative import specifiers from a single file.
// Matches:
//   require('./foo')       require('../bar/baz')
//   require('./foo.js')    require('../bar/baz.json')
//   import x from './foo'  import x from '../bar'
//   import('./foo')        import('../bar')
// Skips:
//   require('express')     — package import
//   require('node:fs')     — built-in
//   require('@scope/pkg')  — scoped package
// ---------------------------------------------------------------
const LOCAL_IMPORT_RE = /(?:require|import)\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)|(?:import\s+.*?\s+from\s+['"](\.\.?\/[^'"]+)['"])/g;

function extractLocalImports(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const results = [];
    let match;
    while ((match = LOCAL_IMPORT_RE.exec(content)) !== null) {
        const specifier = match[1] || match[2];
        if (!specifier) continue;

        // Compute 1-based line number
        const before = content.slice(0, match.index);
        const line = before.split('\n').length;

        results.push({ specifier, line });
    }
    return results;
}

// ---------------------------------------------------------------
// Resolve a local import specifier to possible file paths.
// Checks: exact, +.js, +.json, /index.js, /index.json
// All paths are relative to the directory of the importing file.
// ---------------------------------------------------------------
function resolveCandidates(specifier, fromFile) {
    const dir = path.dirname(fromFile);
    const base = path.join(dir, specifier);

    const candidates = [
        base,                        // exact (might be .js or directory)
        base + '.js',                // ./foo -> ./foo.js
        base + '.json',              // ./foo -> ./foo.json
        path.join(base, 'index.js'), // ./dir -> ./dir/index.js
        path.join(base, 'index.json'),
    ];

    return candidates.map((c) => path.relative(ROOT, c).split(path.sep).join('/'));
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
function main() {
    const files = getTrackedFiles();
    const tracked = getTrackedSet(files);

    let missing = 0;

    for (const file of files) {
        const imports = extractLocalImports(path.join(ROOT, file));
        for (const { specifier, line } of imports) {
            const candidates = resolveCandidates(specifier, file);
            const found = candidates.some((c) => tracked.has(c));

            if (!found) {
                missing += 1;
                console.error(
                    `MISSING: ${file}:${line}  require/import('${specifier}')\n` +
                    `  candidates checked: ${candidates.join(', ')}\n` +
                    `  none are tracked by Git`
                );
            }
        }
    }

    if (missing > 0) {
        console.error(`\n${missing} local import(s) reference untracked files.`);
        console.error('These will cause MODULE_NOT_FOUND in any clean checkout.');
        process.exit(1);
    }

    console.log(`ok  all local imports in ${files.length} tracked files resolve to tracked targets.`);
    process.exit(0);
}

// Allow require() for testing
module.exports = { extractLocalImports, resolveCandidates };

if (require.main === module) {
    main();
}

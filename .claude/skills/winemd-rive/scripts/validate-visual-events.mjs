#!/usr/bin/env node
'use strict';

// Validates a visual-event JSON file (or a JSON array of events) against
// the REAL production schema in src/visual/visualProtocol.js — imports
// that module directly rather than re-implementing the rules here, so
// this validator can never silently drift out of sync with the actual
// contract. Read-only, no external dependencies, no network access.
//
// Usage: node scripts/validate-visual-events.mjs [path/to/event(s).json]
// Defaults to templates/visual-event.template.json if no path is given.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const protocolPath = path.join(repoRoot, 'src', 'visual', 'visualProtocol.js');
const defaultEventPath = path.join(__dirname, '..', 'templates', 'visual-event.template.json');
const targetPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultEventPath;

if (!existsSync(protocolPath)) {
    console.error(`FAIL: cannot find the real schema module at ${protocolPath}`);
    console.error('This validator only checks against the live production contract — it refuses to fall back to a possibly-stale copy of the rules.');
    process.exit(1);
}

const require = createRequire(import.meta.url);
let protocol;
try {
    protocol = require(protocolPath);
} catch (err) {
    console.error(`FAIL: could not load src/visual/visualProtocol.js: ${err.message}`);
    process.exit(1);
}

const { assertVisualEvent, VISUAL_EVENT_TYPES, AVATAR_STATES } = protocol;
if (typeof assertVisualEvent !== 'function' || !(VISUAL_EVENT_TYPES instanceof Set)) {
    console.error('FAIL: src/visual/visualProtocol.js no longer exports the expected assertVisualEvent()/VISUAL_EVENT_TYPES — this script needs updating to match the current module, not the other way around.');
    process.exit(1);
}

if (!existsSync(targetPath)) {
    console.error(`FAIL: event file not found at ${targetPath}`);
    process.exit(1);
}

let data;
try {
    data = JSON.parse(readFileSync(targetPath, 'utf8'));
} catch (err) {
    console.error(`FAIL: ${targetPath} is not valid JSON: ${err.message}`);
    process.exit(1);
}

const events = Array.isArray(data) ? data : [data];
let failCount = 0;
const warnings = [];

events.forEach((event, index) => {
    const label = events.length > 1 ? `event[${index}]` : 'event';
    try {
        assertVisualEvent(event);
        console.log(`PASS: ${label} (type="${event.type}") is a valid visual event.`);
    } catch (err) {
        failCount += 1;
        console.log(`FAIL: ${label} — ${err.message}`);
    }

    // Extra advisory checks beyond assertVisualEvent()'s hard requirements
    if (event.type === 'visual.avatar.state' && event.state && AVATAR_STATES instanceof Set && !AVATAR_STATES.has(event.state)) {
        warnings.push(`${label}: state "${event.state}" is not in AVATAR_STATES (${[...AVATAR_STATES].join(', ')})`);
    }
    if (event.type === 'visual.avatar.state' && event.gesture && !['none', 'present_wine', 'present_pairing', 'present_cta'].includes(event.gesture)) {
        warnings.push(`${label}: gesture "${event.gesture}" is not one of the values currently emitted by src/visual/visualOrchestrator.js — confirm this is intentional (references/troubleshooting.md #4)`);
    }
});

console.log(`\nChecked ${events.length} event(s) from ${targetPath} against ${protocolPath}`);
if (warnings.length > 0) {
    console.log(`\n${warnings.length} advisory warning(s) (do not fail the build):`);
    warnings.forEach((w) => console.log(`  WARN: ${w}`));
}

if (failCount > 0) {
    console.log(`\nRESULT: FAIL (${failCount}/${events.length} event(s) invalid)`);
    process.exit(1);
}
console.log(`\nRESULT: PASS (${events.length}/${events.length} event(s) valid)`);
process.exit(0);

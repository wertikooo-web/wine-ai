#!/usr/bin/env node
'use strict';

// Validates tools/WineMD-Character-SDK/03_rive/rive_manifest.json for
// internal consistency and presence of required fields. Read-only — never
// modifies the manifest. No external dependencies, no network access.
//
// Usage: node scripts/validate-rive-manifest.mjs [path/to/rive_manifest.json]

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const defaultManifestPath = path.join(repoRoot, 'tools', 'WineMD-Character-SDK', '03_rive', 'rive_manifest.json');
const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultManifestPath;

const errors = [];
const warnings = [];

function fail(message) {
    errors.push(message);
}
function warn(message) {
    warnings.push(message);
}

if (!existsSync(manifestPath)) {
    console.error(`FAIL: manifest not found at ${manifestPath}`);
    process.exit(1);
}

let manifest;
try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
    console.error(`FAIL: manifest is not valid JSON: ${err.message}`);
    process.exit(1);
}

// --- Required top-level fields ---
for (const field of ['sdk', 'version', 'artboard', 'stateMachine', 'bones', 'requiredAnimations']) {
    if (!(field in manifest)) fail(`missing top-level field: "${field}"`);
}

// --- Artboard ---
if (manifest.artboard) {
    if (!manifest.artboard.name) fail('artboard.name is missing');
    if (!Array.isArray(manifest.artboard.recommendedSize) || manifest.artboard.recommendedSize.length !== 2) {
        fail('artboard.recommendedSize must be a [width, height] array');
    }
}

// --- State machine inputs ---
// Canonical naming: snake_case everywhere for wire-level value keys and
// animation names (fixed 2026-07-25 — see references/troubleshooting.md #1
// for the camelCase/snake_case history this replaced).
const EXPECTED_INPUTS = {
    mode: { type: 'number', values: { idle: 0, listening: 1, thinking: 2, speaking: 3 } },
    gesture: { type: 'number', values: { none: 0, welcome: 1, present_wine: 2, present_aroma: 3, present_food: 4, point: 5, goodbye: 6 } },
    mouth: { type: 'number', values: { neutral: 0, A: 1, E: 2, O: 3, MBP: 4 } },
    blink: { type: 'trigger' },
    emotion: { type: 'number', values: { neutral: 0, warm: 1, delighted: 2, serious: 3 } },
};

const inputs = manifest.stateMachine?.inputs || [];
const inputsByName = new Map(inputs.map((i) => [i.name, i]));

for (const [name, expected] of Object.entries(EXPECTED_INPUTS)) {
    const actual = inputsByName.get(name);
    if (!actual) {
        fail(`stateMachine.inputs is missing required input "${name}"`);
        continue;
    }
    if (actual.type !== expected.type) {
        fail(`input "${name}" has type "${actual.type}", expected "${expected.type}"`);
    }
    if (expected.values) {
        for (const [key, val] of Object.entries(expected.values)) {
            if (actual.values?.[key] !== val) {
                fail(`input "${name}".values.${key} is ${JSON.stringify(actual.values?.[key])}, expected ${val}`);
            }
        }
        for (const key of Object.keys(actual.values || {})) {
            if (!(key in expected.values)) {
                warn(`input "${name}" has an extra value "${key}" not in the known contract (references/state-machine-contract.md) — confirm this is intentional`);
            }
        }
    }
}

// --- Bones ---
const EXPECTED_BONES = ['root', 'chest', 'neck', 'head', 'shoulder_l', 'elbow_l', 'hand_l', 'shoulder_r', 'elbow_r', 'hand_r'];
const bones = Array.isArray(manifest.bones) ? manifest.bones : [];
for (const bone of EXPECTED_BONES) {
    if (!bones.includes(bone)) fail(`bones is missing required bone "${bone}"`);
}

// --- Required animations ---
const EXPECTED_ANIMATIONS = ['idle', 'listening', 'thinking', 'speaking', 'welcome', 'present_wine', 'present_aroma', 'present_food', 'point', 'goodbye', 'blink'];
const PHASE_1_ANIMATIONS = ['idle', 'speaking', 'present_wine', 'blink'];
const animations = Array.isArray(manifest.requiredAnimations) ? manifest.requiredAnimations : [];

for (const anim of EXPECTED_ANIMATIONS) {
    if (!animations.includes(anim)) fail(`requiredAnimations is missing "${anim}"`);
}
for (const anim of PHASE_1_ANIMATIONS) {
    if (!animations.includes(anim)) fail(`requiredAnimations is missing Phase-1-critical animation "${anim}"`);
}

// --- "smile" must NOT reappear as a required animation unless a real
// input/trigger backs it (regression check — see references/troubleshooting.md #2:
// it was removed 2026-07-25 for existing only to silence this validator) ---
if (animations.includes('smile')) {
    const hasSmileInput = inputs.some((i) => i.name === 'smile');
    if (!hasSmileInput) {
        fail('"smile" is a required animation but no state-machine input/trigger can invoke it (see references/troubleshooting.md #2 — do not re-add smile without a real trigger AND a real orchestrator event driving it)');
    }
}

// --- Gesture value casing must be snake_case throughout (regression check
// for a previously-fixed gap — see references/troubleshooting.md #1) ---
const gestureInput = inputsByName.get('gesture');
if (gestureInput?.values) {
    const camelCaseGestures = Object.keys(gestureInput.values).filter((k) => /[a-z][A-Z]/.test(k));
    if (camelCaseGestures.length > 0) {
        fail(`gesture input values must be snake_case; found camelCase: ${camelCaseGestures.join(', ')} (regression — this was fixed 2026-07-25, see references/troubleshooting.md #1)`);
    }
}

// --- "pointing" must not be silently re-mapped to present_food (regression
// check — see references/troubleshooting.md #7) ---
if (gestureInput?.values && !('point' in gestureInput.values)) {
    warn('gesture input has no generic "point" value — if "pointing" is mapped to "present_food" again, confirm the orchestrator now emits real food/pairing semantics (see references/troubleshooting.md #7)');
}

// --- Report ---
console.log(`Checked: ${manifestPath}`);
if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`  WARN: ${w}`));
}
if (errors.length > 0) {
    console.log(`\n${errors.length} error(s):`);
    errors.forEach((e) => console.log(`  FAIL: ${e}`));
    console.log(`\nRESULT: FAIL (${errors.length} error(s), ${warnings.length} warning(s))`);
    process.exit(1);
}
console.log(`\nRESULT: PASS (0 errors, ${warnings.length} warning(s))`);
process.exit(0);

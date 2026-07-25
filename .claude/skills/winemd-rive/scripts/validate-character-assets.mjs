#!/usr/bin/env node
'use strict';

// Validates exported character assets when present: PNG dimensions/color
// type/canvas-size consistency (via a minimal hand-rolled PNG header
// reader — no image library dependency), and explicitly reports what it
// CANNOT verify (binary .riv contents, PSD layer structure) rather than
// silently skipping them. Read-only, no external dependencies, no network.
//
// Usage: node scripts/validate-character-assets.mjs [directory]
// Defaults to tools/WineMD-Character-SDK/ (recursive).

import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repoRoot, 'tools', 'WineMD-Character-SDK');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_NAMES = { 0: 'grayscale', 2: 'RGB (no alpha)', 3: 'palette', 4: 'grayscale+alpha', 6: 'RGBA' };

function walk(dir, results = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else {
            results.push(full);
        }
    }
    return results;
}

// Minimal PNG IHDR reader — no dependency on any image library.
// PNG layout: 8-byte signature, then chunks; the first chunk is always
// IHDR: 4-byte length, 4-byte type "IHDR", then 13 bytes of data
// (width:4, height:4, bitDepth:1, colorType:1, ...), then 4-byte CRC.
function readPngHeader(filePath) {
    const buf = readFileSync(filePath);
    if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf.readUInt8(24);
    const colorType = buf.readUInt8(25);
    return { width, height, bitDepth, colorType, colorTypeName: COLOR_TYPE_NAMES[colorType] || `unknown(${colorType})` };
}

if (!statSync(targetDir, { throwIfNoEntry: false })) {
    console.error(`FAIL: directory not found: ${targetDir}`);
    process.exit(1);
}

const allFiles = walk(targetDir);
const pngFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.png'));
const rivFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.riv'));
const psdFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.psd'));

const errors = [];
const warnings = [];
const notes = [];

console.log(`Scanning: ${targetDir}`);
console.log(`Found: ${pngFiles.length} PNG(s), ${rivFiles.length} .riv file(s), ${psdFiles.length} PSD file(s)\n`);

// --- PNG checks ---
const pngReports = [];
for (const file of pngFiles) {
    const size = statSync(file).size;
    const header = readPngHeader(file);
    const rel = path.relative(repoRoot, file);
    if (!header) {
        errors.push(`${rel}: not a valid PNG (bad signature)`);
        continue;
    }
    if (size < 1024) {
        warnings.push(`${rel}: only ${size} bytes — suspiciously small for real character art; verify it isn't a placeholder`);
    }
    if (header.colorType !== 6 && header.colorType !== 4) {
        warnings.push(`${rel}: color type is "${header.colorTypeName}", not RGBA — EXPORT_RULES.md requires RGBA with transparency`);
    }
    pngReports.push({ rel, size, ...header });
    console.log(`  ${rel}: ${header.width}x${header.height}, ${header.colorTypeName}, ${(size / 1024).toFixed(1)} KB`);
}

// --- Canvas-size consistency (only meaningful for a set of layer exports meant to align) ---
if (pngReports.length > 1) {
    const sizes = new Set(pngReports.map((r) => `${r.width}x${r.height}`));
    if (sizes.size > 1) {
        notes.push(`PNG canvas sizes are not uniform across all ${pngReports.length} files (${[...sizes].join(', ')}) — this is EXPECTED for unrelated reference images (master art vs. icons), but if these are supposed to be aligned layer exports from the same PSD, EXPORT_RULES.md requires "identical canvas size, no trimming."`);
    }
}

// --- .riv files: explicitly cannot verify contents ---
if (rivFiles.length === 0) {
    notes.push('No .riv file found. This is expected until the rig is built in the Rive editor — see references/rive-rig-contract.md. Do not treat this as an error, and do not fabricate one.');
} else {
    for (const file of rivFiles) {
        const rel = path.relative(repoRoot, file);
        const size = statSync(file).size;
        notes.push(`${rel} exists (${(size / 1024).toFixed(1)} KB) — this script CANNOT verify binary .riv contents (bones, state machine, animations). Open it in the actual Rive runtime/editor to verify; see references/testing-checklist.md.`);
    }
}

// --- PSD files: existence only, layer structure cannot be checked without a PSD-parsing dependency ---
if (psdFiles.length === 0) {
    notes.push('No .psd file found. Expected until the layered source is produced — see references/psd-layer-contract.md and references/art-pipeline.md. Do not fabricate a multi-layer PSD from a flattened PNG.');
} else {
    for (const file of psdFiles) {
        const rel = path.relative(repoRoot, file);
        notes.push(`${rel} exists — this script CANNOT verify PSD layer names/structure without an image-editing tool or a PSD-parsing dependency (deliberately not added, per the skill's "no unnecessary dependencies" rule). Open it in Photoshop/an equivalent tool and check manually against references/psd-layer-contract.md's layer tree.`);
    }
}

// --- Report ---
if (notes.length > 0) {
    console.log(`\n${notes.length} note(s) (things this script cannot fully verify):`);
    notes.forEach((n) => console.log(`  NOTE: ${n}`));
}
if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`  WARN: ${w}`));
}
if (errors.length > 0) {
    console.log(`\n${errors.length} error(s):`);
    errors.forEach((e) => console.log(`  FAIL: ${e}`));
    console.log(`\nRESULT: FAIL (${errors.length} error(s))`);
    process.exit(1);
}
console.log(`\nRESULT: PASS (0 errors, ${warnings.length} warning(s), ${notes.length} note(s) needing manual verification)`);
process.exit(0);

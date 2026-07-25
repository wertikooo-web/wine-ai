'use strict';

// Canonical normalized avatar command — the ONE shape every avatar runtime
// (Rive today, anything else tomorrow) is allowed to consume. Lives in
// public/visual/ (not src/visual/) deliberately: this is a client-side
// rendering concern, same as public/visual/VisualStoryController.mjs,
// which already establishes the precedent of duplicating small protocol
// constants client-side rather than sharing a Node module across the
// server/browser boundary (this repo has no bundler — see
// .claude/skills/winemd-rive/references/architecture.md's framework
// constraint). Node's test runner can still `import()` this .mjs file
// directly (see tests/avatarSemanticAdapter.test.js).
//
// Field set is deliberately minimal — only what src/visual/visualOrchestrator.js
// can actually drive today, or what a runtime adapter needs structurally
// (generationId for staleness). Do not add fields "for completeness."

export const MODES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);
export const GESTURES = Object.freeze(['none', 'welcome', 'present_wine', 'present_aroma', 'present_food', 'point', 'goodbye']);
export const EMOTIONS = Object.freeze(['neutral', 'warm', 'delighted', 'serious']);
// Mouth is a discrete 0-4 enum per tools/WineMD-Character-SDK/03_rive/STATE_MACHINE.md
// (0 Neutral, 1 A, 2 E, 3 O, 4 MBP). MVP only ever produces 0/1/4 — see
// avatarSemanticAdapter.mjs's amplitude-threshold function and
// tools/WineMD-Character-SDK/02_psd_spec/MOUTH_AND_EYES.md ("For MVP, audio
// amplitude may switch between neutral, A and M-B-P").
export const MOUTH_VALUES = Object.freeze([0, 1, 2, 3, 4]);

/**
 * @typedef {Object} AvatarCommand
 * @property {string} generationId
 * @property {'idle'|'listening'|'thinking'|'speaking'} mode
 * @property {'none'|'welcome'|'present_wine'|'present_aroma'|'present_food'|'point'|'goodbye'} gesture
 * @property {'neutral'|'warm'|'delighted'|'serious'} emotion
 * @property {0|1|2|3|4} mouth
 * @property {boolean} blink
 */

function isSafeGenerationId(value) {
    // Same rule as src/visual/visualProtocol.js's isSafeIdentifier — kept
    // in sync manually (no shared module across the Node/browser boundary,
    // see the file-level comment above).
    return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

/**
 * Throws on any structurally invalid command. Never mutates; returns the
 * validated command unchanged so it can be used inline.
 * @param {AvatarCommand} command
 * @returns {AvatarCommand}
 */
export function assertAvatarCommand(command) {
    if (!command || typeof command !== 'object') throw new TypeError('avatar_command_must_be_object');
    if (!isSafeGenerationId(command.generationId)) throw new TypeError('avatar_command_generation_id_invalid');
    if (!MODES.includes(command.mode)) throw new TypeError(`avatar_command_mode_invalid: ${command.mode}`);
    if (!GESTURES.includes(command.gesture)) throw new TypeError(`avatar_command_gesture_invalid: ${command.gesture}`);
    if (!EMOTIONS.includes(command.emotion)) throw new TypeError(`avatar_command_emotion_invalid: ${command.emotion}`);
    if (!MOUTH_VALUES.includes(command.mouth)) throw new TypeError(`avatar_command_mouth_invalid: ${command.mouth}`);
    if (typeof command.blink !== 'boolean') throw new TypeError('avatar_command_blink_must_be_boolean');
    return command;
}

/**
 * @param {{generationId: string, mode?: string, gesture?: string, emotion?: string, mouth?: number, blink?: boolean}} fields
 * @returns {AvatarCommand}
 */
export function createAvatarCommand({ generationId, mode = 'idle', gesture = 'none', emotion = 'neutral', mouth = 0, blink = false }) {
    return assertAvatarCommand({ generationId, mode, gesture, emotion, mouth, blink });
}

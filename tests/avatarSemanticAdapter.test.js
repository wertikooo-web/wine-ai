'use strict';

// Tests the WineMD Rive contract layer added by the winemd-rive skill:
// public/visual/avatarCommandSchema.mjs, avatarSemanticAdapter.mjs, and
// riveAvatarAdapter.mjs. These are ES modules (browser-loadable, matching
// public/visual/VisualStoryController.mjs's own style — see
// .claude/skills/winemd-rive/references/architecture.md) — Node's dynamic
// import() loads them fine from this CommonJS test file.
const path = require('path');
const { pathToFileURL } = require('url');
const t = require('./helpers/assertions');

const VISUAL_DIR = path.resolve(__dirname, '..', 'public', 'visual');

// import() requires a proper file:// URL on Windows (a bare "D:\..." path
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME) — pathToFileURL() handles this
// portably across platforms.
async function loadModules() {
    const schema = await import(pathToFileURL(path.join(VISUAL_DIR, 'avatarCommandSchema.mjs')).href);
    const adapter = await import(pathToFileURL(path.join(VISUAL_DIR, 'avatarSemanticAdapter.mjs')).href);
    const runtime = await import(pathToFileURL(path.join(VISUAL_DIR, 'riveAvatarAdapter.mjs')).href);
    return { schema, adapter, runtime };
}

function makeVisualEvent({ state, gesture = 'none', emotion = 'neutral', mouthOpen = 0, generationId = 'generation_test0000000000000000', sequence = 1 }) {
    return {
        type: 'visual.avatar.state',
        protocolVersion: 1,
        generationId,
        sequence,
        state,
        speechAmplitude: 0,
        mouthOpen,
        emotion,
        gesture,
        intensity: 0.5,
    };
}

async function run() {
    const { adapter, runtime } = await loadModules();

    // --- 1. Correct mapping of states the real orchestrator actually emits ---
    {
        const semanticAdapter = adapter.createAvatarSemanticAdapter();
        const cases = [
            { state: 'idle', expectMode: 'idle', expectGesture: 'none' },
            { state: 'listening', expectMode: 'listening', expectGesture: 'none' },
            { state: 'thinking', expectMode: 'thinking', expectGesture: 'none' },
            { state: 'speaking', expectMode: 'speaking', expectGesture: 'none' },
            { state: 'presenting_wine', gesture: 'present_wine', expectMode: 'speaking', expectGesture: 'present_wine' },
            { state: 'pointing', gesture: 'present_pairing', expectMode: 'speaking', expectGesture: 'point' },
        ];
        for (const c of cases) {
            const event = makeVisualEvent({ state: c.state, gesture: c.gesture });
            const command = semanticAdapter.translate(event);
            t.ok(command, `expected a command for state "${c.state}"`);
            t.equal(command.mode, c.expectMode, `state "${c.state}" -> mode`);
            t.equal(command.gesture, c.expectGesture, `state "${c.state}" -> gesture`);
            t.equal(command.generationId, event.generationId, `state "${c.state}" preserves generationId`);
        }
    }

    // --- 2. Unknown state falls back to idle (not a crash, not invented behavior) ---
    {
        const semanticAdapter = adapter.createAvatarSemanticAdapter();
        const event = makeVisualEvent({ state: 'some_future_state_not_in_avatar_states' });
        const command = semanticAdapter.translate(event);
        t.equal(command.mode, 'idle', 'unrecognized state falls back to idle mode');
        t.equal(command.gesture, 'none', 'unrecognized state falls back to no gesture');
    }

    // --- 3. Declared-but-never-emitted states (greeting/enthusiastic/goodbye) have a defined, safe fallback ---
    {
        const semanticAdapter = adapter.createAvatarSemanticAdapter();
        for (const state of ['greeting', 'enthusiastic', 'goodbye']) {
            const command = semanticAdapter.translate(makeVisualEvent({ state }));
            t.ok(command, `state "${state}" (declared in AVATAR_STATES but never emitted today) still produces a valid command`);
            t.ok(['idle', 'speaking'].includes(command.mode), `state "${state}" falls back to a safe mode`);
        }
    }

    // --- 4. mouthOpen amplitude -> discrete mouth enum (MVP: neutral/A/MBP only) ---
    {
        t.equal(adapter.amplitudeToMouth(0), 0, 'silence -> neutral');
        t.equal(adapter.amplitudeToMouth(0.3), 1, 'mid amplitude -> A');
        t.equal(adapter.amplitudeToMouth(0.9), 4, 'high amplitude -> MBP');
    }

    // --- 5. blink is never derived from a visual event (see avatarSemanticAdapter.mjs's header comment) ---
    {
        const semanticAdapter = adapter.createAvatarSemanticAdapter();
        const command = semanticAdapter.translate(makeVisualEvent({ state: 'idle' }));
        t.equal(command.blink, false, 'blink is always false from the semantic adapter — it is a runtime-timer concern, not event-derived');
    }

    // --- 6. Stale generationId is ignored by the runtime (AvatarCommandRuntime) ---
    {
        const inputAdapter = runtime.createDebugInputAdapter();
        const rt = new runtime.AvatarCommandRuntime(inputAdapter);
        const genA = 'generation_aaaaaaaaaaaaaaaa';
        const genB = 'generation_bbbbbbbbbbbbbbbb';

        rt.apply(schemaCommand(genA, 'speaking'));
        t.equal(inputAdapter.getState().mode, 'speaking', 'first command for a fresh generation is applied');

        rt.apply(schemaCommand(genB, 'listening'));
        t.equal(inputAdapter.getState().mode, 'speaking', 'a command from a DIFFERENT (stale) generationId while genA is still active must be ignored');
    }

    // --- 7. Interruption: endGeneration releases the claim so the NEXT generation is accepted ---
    {
        const inputAdapter = runtime.createDebugInputAdapter();
        const rt = new runtime.AvatarCommandRuntime(inputAdapter);
        const genA = 'generation_cccccccccccccccc';
        const genB = 'generation_dddddddddddddddd';

        rt.apply(schemaCommand(genA, 'speaking'));
        rt.endGeneration(genA); // simulates cancellation / interruption
        t.equal(inputAdapter.getState().mode, 'idle', 'endGeneration resets mode to idle');
        t.equal(inputAdapter.getState().gesture, 'none', 'endGeneration resets gesture to none');

        rt.apply(schemaCommand(genB, 'listening'));
        t.equal(inputAdapter.getState().mode, 'listening', 'a NEW generation is accepted after the previous one ended');
    }

    // --- 7b. endGeneration on an ALREADY-superseded id must not reset a newer generation's state ---
    {
        const inputAdapter = runtime.createDebugInputAdapter();
        const rt = new runtime.AvatarCommandRuntime(inputAdapter);
        const genA = 'generation_eeeeeeeeeeeeeeee';
        const genB = 'generation_ffffffffffffffff';

        rt.apply(schemaCommand(genA, 'speaking'));
        rt.endGeneration(genA);
        rt.apply(schemaCommand(genB, 'listening'));
        // A late/delayed endGeneration for the OLD id (genA) arriving after
        // genB already claimed the runtime must be a no-op, matching
        // SommelierController.ts's exact guard.
        rt.endGeneration(genA);
        t.equal(inputAdapter.getState().mode, 'listening', 'a stale endGeneration(genA) must not reset the now-active genB state');
    }

    // --- 8. Absence of a .riv file must not break anything — these modules have zero Rive dependency ---
    {
        t.ok(typeof runtime.AvatarCommandRuntime === 'function', 'AvatarCommandRuntime loads with no Rive package installed at all');
        const inputAdapter = runtime.createDebugInputAdapter();
        const rt = new runtime.AvatarCommandRuntime(inputAdapter);
        rt.apply(schemaCommand('generation_gggggggggggggggg', 'idle'));
        t.ok(true, 'applying a command through the debug (non-Rive) input adapter does not throw');
    }

    function schemaCommand(generationId, mode) {
        return { generationId, mode, gesture: 'none', emotion: 'neutral', mouth: 0, blink: false };
    }
}

module.exports = { run };

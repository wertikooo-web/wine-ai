'use strict';

// Semi-automated per AGENTS.md/docs/WINE_AI_MIGRATION_PLAN.md: the language
// *detector* (deterministic, no LLM) is always exercised here. The actual
// "does the model reply in the right language" check needs a real Gemini
// Live connection and an API key, so it only runs when both
// REALTIME_PROVIDER=gemini and GEMINI_API_KEY are set — otherwise this
// prints a clear skip notice instead of silently passing.
const { spawn } = require('child_process');
const path = require('path');
const { detectLikelyLanguage } = require('../src/realtime/realtimeServer');
const { connect } = require('../tests/helpers/wsTestClient');

const DETECTION_CASES = [
    ['Расскажи, чем Фетяска Нягрэ отличается от Каберне Совиньон.', 'ru'],
    ['Povestește-mi despre soiul Fetească Neagră și despre regiunile în care este cultivat.', 'ro'],
    ['Which Moldovan wine would you recommend with roast lamb?', 'en'],
];

const SWITCH_SEQUENCE = [
    'Расскажи о винодельне на русском.',
    'Acum continuă în limba română.',
    'Now summarize it in English.',
];

function runDetectionChecks() {
    let failed = 0;
    for (const [phrase, expected] of DETECTION_CASES) {
        const detected = detectLikelyLanguage(phrase);
        const pass = detected === expected;
        console.log(`${pass ? 'ok  ' : 'FAIL'} detect("${phrase.slice(0, 40)}...") -> ${detected} (expected ${expected})`);
        if (!pass) failed += 1;
    }
    return failed;
}

function waitForHealth(port, deadline) {
    return fetch(`http://localhost:${port}/health`).then((res) => res.ok, () => {
        if (Date.now() > deadline) throw new Error('server did not become healthy in time');
        return new Promise((resolve) => setTimeout(resolve, 150)).then(() => waitForHealth(port, deadline));
    });
}

async function runLiveSwitchCheck() {
    const port = Number(process.env.SMOKE_LANGUAGE_PORT || 8793);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(port), REALTIME_PROVIDER: 'gemini' },
        stdio: 'pipe',
    });
    try {
        await waitForHealth(port, Date.now() + 8000);
        const client = await connect(port);
        await client.waitFor((e) => e.type === 'session.ready');
        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied');

        for (const phrase of SWITCH_SEQUENCE) {
            client.sendJson({ type: 'input_text.submit', text: phrase });
            const reply = await client.waitFor((e) => e.type === 'transcript.model', { timeoutMs: 15000 });
            console.log(`live: "${phrase}"\n  -> ${reply.text}`);
            await client.waitFor((e) => e.type === 'audio.end', { timeoutMs: 15000 });
        }
        client.close();
        console.log('\nlive language-switch check completed — read the replies above to confirm each language.');
    } finally {
        try { child.kill(); } catch { /* already gone */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}

async function main() {
    const detectionFailures = runDetectionChecks();

    const liveEnabled = process.env.REALTIME_PROVIDER === 'gemini' && Boolean(process.env.GEMINI_API_KEY);
    if (liveEnabled) {
        await runLiveSwitchCheck();
    } else {
        console.log('\nskip: live ru/ro/en switching check — set REALTIME_PROVIDER=gemini and GEMINI_API_KEY to run it.');
    }

    if (detectionFailures > 0) {
        console.error(`\nlanguage-smoke FAILED (${detectionFailures} detection case(s))`);
        process.exit(1);
    }
    console.log('\nlanguage-smoke passed (detection layer' + (liveEnabled ? ' + live check' : ', live check skipped') + ')');
    process.exit(0);
}

main();

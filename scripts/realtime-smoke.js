'use strict';

// Black-box smoke test: spawns the real server process and drives a full
// text-based turn over the actual /realtime WebSocket, end to end.
const { spawn } = require('child_process');
const path = require('path');
const { connect } = require('../tests/helpers/wsTestClient');

const PORT = Number(process.env.SMOKE_REALTIME_PORT || 8792);

function waitForHealth(deadline) {
    return fetch(`http://localhost:${PORT}/health`).then((res) => res.ok, () => {
        if (Date.now() > deadline) throw new Error('server did not become healthy in time');
        return new Promise((resolve) => setTimeout(resolve, 150)).then(() => waitForHealth(deadline));
    });
}

async function main() {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), REALTIME_PROVIDER: 'mock' },
        stdio: 'pipe',
    });

    try {
        await waitForHealth(Date.now() + 5000);

        const client = await connect(PORT);
        const ready = await client.waitFor((e) => e.type === 'session.ready', { label: 'session.ready' });
        console.log('ok   session.ready', ready.session_id);

        client.sendJson({ type: 'session.start', sampleRate: 16000 });
        await client.waitFor((e) => e.type === 'session.config.applied', { label: 'session.config.applied' });
        console.log('ok   session.config.applied');

        client.sendJson({ type: 'input_text.submit', text: 'Расскажи о молдавском вине' });
        const submitted = await client.waitFor((e) => e.type === 'input_text.submitted', { label: 'input_text.submitted' });
        console.log('ok   input_text.submitted', JSON.stringify(submitted.text));

        const modelTranscript = await client.waitFor((e) => e.type === 'transcript.model', { label: 'transcript.model' });
        console.log('ok   transcript.model', JSON.stringify(modelTranscript.text));

        await client.waitFor((e) => e.type === 'audio.end', { label: 'audio.end', timeoutMs: 6000 });
        console.log('ok   audio.end (turn completed)');

        client.close();
        console.log('\nrealtime-smoke passed');
        try { child.kill(); } catch { /* already gone */ }
        setTimeout(() => process.exit(0), 150);
    } catch (error) {
        console.error('FAIL', error.message);
        try { child.kill(); } catch { /* already gone */ }
        setTimeout(() => process.exit(1), 150);
    }
}

main();

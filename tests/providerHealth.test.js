'use strict';

// Provider health (src/observability/providerHealth.js): quota/auth errors
// from realtime log lines are classified and counted; the Gemini probe
// reports a depleted balance.

const t = require('./helpers/assertions');
const health = require('../src/observability/providerHealth');

async function run() {
    let n = 0;
    const ok = (c, m) => { t.ok(c, m); n += 1; };
    health._reset();

    ok(health.classify('429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted') === 'quota', 'credits depleted = quota');
    ok(health.classify('API key not valid. Please pass a valid API key.') === 'auth', 'bad key = auth');
    ok(health.classify('socket hang up') === null, 'other errors unclassified');

    ok(health.observe('transcript_model', { message: 'quota' }) === null, 'unrelated stages ignored');
    ok(health.observe('gemini_close', { reason: 'closed' }) === null, 'ordinary close ignored');
    health.observe('gemini_close', { reason: 'You exceeded your current quota, please check your plan and billing details' });
    health.observe('provider_error', { code: 'provider_error', provider: 'gemini', message: 'socket hang up' });
    const s = health.summary();
    ok(s.counts.quota === 1 && s.counts.other === 1 && s.last_quota.provider === 'gemini', `counted (${JSON.stringify(s.counts)})`);
    ok(health.summary({ now: Date.now() + 2 * 60 * 60 * 1000 }).counts.quota === 0, 'window expires old errors');

    const good = await health.probeGemini({ generate: async () => ({ text: 'o' }) });
    ok(good.ok === true, 'probe ok');
    const bad = await health.probeGemini({ generate: async () => { throw new Error('[429] Your prepayment credits are depleted.'); } });
    ok(bad.ok === false && bad.kind === 'quota', 'probe reports depleted credits');
    const slow = await health.probeGemini({ generate: () => new Promise(() => {}), timeoutMs: 30 });
    ok(slow.ok === false && slow.kind === 'timeout', 'probe timeout');
    ok(health.grokConfigured({ XAI_API_KEY: 'x' }) === true && health.grokConfigured({}) === false, 'grok key detection');

    // after a top-up: probe ok wins over earlier session quota errors
    ok(health.verdict({ probe: { ok: true }, sessions: { counts: { quota: 8, auth: 0 } } }) === true, 'live probe ok = usable, despite old session errors');
    ok(health.verdict({ probe: null, sessions: { counts: { quota: 1, auth: 0 } } }) === false, 'without a probe, session quota errors = not ok');

    health._reset();
    let calls = 0;
    let clock = 0;
    const probe = async () => { calls += 1; return { ok: calls > 1 }; };
    const a = await health.cachedProbe({ probe, now: () => clock, ttlMs: 1000 });
    const b = await health.cachedProbe({ probe, now: () => clock, ttlMs: 1000 });
    clock = 2000;
    const c = await health.cachedProbe({ probe, now: () => clock, ttlMs: 1000 });
    ok(calls === 2 && a.ok === false && b.ok === false && c.ok === true, 'public probe cached per ttl (one Gemini call per window)');

    health._reset();
    return { assertionCount: n };
}

module.exports = { run };

if (require.main === module) {
    run().then((r) => { console.log(`providerHealth passed (${r.assertionCount})`); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

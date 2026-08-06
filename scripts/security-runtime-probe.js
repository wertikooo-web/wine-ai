'use strict';

const BASE_URL = String(process.env.SECURITY_BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const EXPECTED_SHA = String(process.env.EXPECTED_DEPLOY_SHA || '').trim();

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    ...options,
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, text };
}

function check(condition, id, detail) {
  if (!condition) throw new Error(`${id}: ${detail}`);
  console.log(`PASS ${id}: ${detail}`);
}

async function main() {
  const findings = [];

  const health = await request('/health');
  check(health.status === 200 && health.body?.ok === true, 'SEC-RUN-001', 'production health responds');

  if (EXPECTED_SHA) {
    const deployedSha = String(health.body?.deployment?.commit_sha || health.body?.commit_sha || '');
    check(deployedSha.startsWith(EXPECTED_SHA) || EXPECTED_SHA.startsWith(deployedSha), 'SEC-RUN-002', `deployed SHA matches ${EXPECTED_SHA}`);
  }

  const persona = await request('/api/persona');
  check(persona.status === 200, 'SEC-RUN-003', 'public persona endpoint responds');
  const leakedFields = ['system_prompt', 'effectivePromptPreview', 'overrides'].filter((key) => Object.hasOwn(persona.body || {}, key));
  if (leakedFields.length) findings.push({ id: 'SEC-FIND-001', severity: 'high', detail: `Public /api/persona exposes: ${leakedFields.join(', ')}` });

  const oversized = 'x'.repeat(70 * 1024);
  const oversizedResponse = await request('/api/age-verification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true, padding: oversized }),
  });
  check([400, 413].includes(oversizedResponse.status), 'SEC-RUN-004', 'oversized JSON is rejected');

  const invalidJson = await request('/api/age-verification', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid',
  });
  check(invalidJson.status === 400, 'SEC-RUN-005', 'invalid JSON is rejected');

  const traversal = await request('/visual-assets/../../package.json');
  check([400, 404].includes(traversal.status), 'SEC-RUN-006', 'path traversal is rejected');

  if (findings.length) {
    console.error('\nSecurity findings:');
    for (const finding of findings) console.error(`${finding.severity.toUpperCase()} ${finding.id}: ${finding.detail}`);
    process.exitCode = 2;
  } else {
    console.log('\nNo findings in runtime probe set.');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

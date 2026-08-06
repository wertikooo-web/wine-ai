'use strict';

const BASE_URL = String(process.env.SECURITY_BASE_URL || 'https://wine-ai-realtime-production.up.railway.app').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.SECURITY_TIMEOUT_MS || 20000);

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    signal: timeoutSignal(),
    ...options,
    headers: {
      'user-agent': 'wine-ai-security-runtime/1.0',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON is valid for some probes */ }
  return { response, text, json };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function flattenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    entries.push(path);
    entries.push(...flattenKeys(child, path));
  }
  return entries;
}

const forbiddenSecretKeys = /(api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|client[_-]?secret)$/i;
const secretValuePatterns = [
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-[0-9A-Za-z_-]{16,}/,
  /xai-[0-9A-Za-z_-]{16,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const tests = [
  {
    id: 'RT-001',
    name: 'Health endpoint is available and JSON',
    run: async () => {
      const { response, json } = await request('/health');
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(json?.ok === true, 'health ok must be true');
      assert(json?.service === 'wine-ai-realtime', 'unexpected service identity');
    },
  },
  {
    id: 'RT-002',
    name: 'Health response does not expose secret-shaped fields',
    run: async () => {
      const { json, text } = await request('/health');
      assert(json && typeof json === 'object', 'health must return JSON');
      const badKeys = flattenKeys(json).filter((key) => forbiddenSecretKeys.test(key.split('.').at(-1)));
      assert(badKeys.length === 0, `secret-shaped keys exposed: ${badKeys.join(', ')}`);
      for (const pattern of secretValuePatterns) assert(!pattern.test(text), `secret-shaped value matched ${pattern}`);
    },
  },
  {
    id: 'RT-003',
    name: 'Health response is not cacheable',
    run: async () => {
      const { response } = await request('/health');
      const cacheControl = response.headers.get('cache-control') || '';
      assert(/no-store/i.test(cacheControl), `expected no-store, got ${cacheControl || '(missing)'}`);
    },
  },
  {
    id: 'RT-004',
    name: 'Malformed JSON is rejected',
    run: async () => {
      const { response, json } = await request('/api/age-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      });
      assert(response.status === 400, `expected 400, got ${response.status}`);
      assert(json?.ok === false, 'error response must set ok=false');
    },
  },
  {
    id: 'RT-005',
    name: 'Oversized JSON body is blocked',
    run: async () => {
      const oversized = JSON.stringify({ confirmed: true, padding: 'x'.repeat(70 * 1024) });
      const { response } = await request('/api/age-verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: oversized,
      });
      assert(response.status === 413 || response.status === 400, `expected 413/400, got ${response.status}`);
    },
  },
  {
    id: 'RT-006',
    name: 'Path traversal probe is rejected',
    run: async () => {
      const { response } = await request('/..%2F..%2Fetc%2Fpasswd.png');
      assert(response.status === 404 || response.status === 400, `expected 404/400, got ${response.status}`);
    },
  },
  {
    id: 'RT-007',
    name: 'Script-tag path probe is not reflected',
    run: async () => {
      const marker = 'wineai-security-xss-marker';
      const { response, text } = await request(`/%3Cscript%3E${marker}%3C%2Fscript%3E`);
      assert(response.status === 404 || response.status === 400, `expected 404/400, got ${response.status}`);
      assert(!text.includes(`<script>${marker}</script>`), 'raw script payload reflected in response');
    },
  },
  {
    id: 'RT-008',
    name: 'Unknown API route does not disclose stack traces',
    run: async () => {
      const { response, text } = await request('/api/security-probe-does-not-exist');
      assert(response.status === 404, `expected 404, got ${response.status}`);
      assert(!/\bat\s+[^\n]+:\d+:\d+/.test(text), 'stack trace disclosed');
      assert(!text.includes(process.cwd()), 'server filesystem path disclosed');
    },
  },
  {
    id: 'RT-009',
    name: 'Public persona response contains no provider credentials',
    run: async () => {
      const { response, text } = await request('/api/persona');
      assert(response.status === 200, `expected 200, got ${response.status}`);
      for (const pattern of secretValuePatterns) assert(!pattern.test(text), `credential-like value matched ${pattern}`);
    },
  },
  {
    id: 'RT-010',
    name: 'Dashboard is served with no-store caching',
    run: async () => {
      const { response, text } = await request('/dashboard');
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(text.length > 1000, 'dashboard response unexpectedly small');
      const cacheControl = response.headers.get('cache-control') || '';
      assert(/no-store/i.test(cacheControl), `expected no-store, got ${cacheControl || '(missing)'}`);
    },
  },
];

(async () => {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const test of tests) {
    const started = Date.now();
    try {
      await test.run();
      results.push({ id: test.id, name: test.name, status: 'PASS', duration_ms: Date.now() - started });
      console.log(`PASS ${test.id} ${test.name}`);
    } catch (error) {
      results.push({ id: test.id, name: test.name, status: 'FAIL', duration_ms: Date.now() - started, error: error.message });
      console.error(`FAIL ${test.id} ${test.name}: ${error.message}`);
    }
  }

  const failed = results.filter((item) => item.status === 'FAIL');
  const report = {
    suite: 'wine-ai-runtime-security-v1',
    base_url: BASE_URL,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
  };
  console.log(`SECURITY_RUNTIME_RESULT ${JSON.stringify(report)}`);
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error('security runtime runner failed:', error);
  process.exitCode = 1;
});

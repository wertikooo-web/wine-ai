const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CASES_PATH = path.join(ROOT, 'tests', 'security', 'cases.json');
const REQUIRED_CATEGORIES = [
  'prompt-injection',
  'rag-poisoning',
  'commercial-integrity',
  'output-safety',
  'authorization',
  'websocket',
  'memory-isolation',
  'secret-exposure'
];
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function fail(message) {
  console.error(`SECURITY FOUNDATION FAILED: ${message}`);
  process.exitCode = 1;
}

function main() {
  if (!fs.existsSync(CASES_PATH)) {
    fail(`missing ${path.relative(ROOT, CASES_PATH)}`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  } catch (error) {
    fail(`invalid JSON: ${error.message}`);
    return;
  }

  if (!Array.isArray(payload.cases) || payload.cases.length < 10) {
    fail('at least 10 security cases are required');
    return;
  }

  const ids = new Set();
  const categories = new Set();

  for (const testCase of payload.cases) {
    if (!testCase.id || typeof testCase.id !== 'string') {
      fail('every case must have a string id');
      continue;
    }
    if (ids.has(testCase.id)) {
      fail(`duplicate case id ${testCase.id}`);
    }
    ids.add(testCase.id);

    if (!testCase.category || typeof testCase.category !== 'string') {
      fail(`${testCase.id} is missing category`);
    } else {
      categories.add(testCase.category);
    }

    if (!VALID_SEVERITIES.has(testCase.severity)) {
      fail(`${testCase.id} has invalid severity`);
    }

    if (!testCase.expectedBehavior || typeof testCase.expectedBehavior !== 'string') {
      fail(`${testCase.id} is missing expectedBehavior`);
    }
  }

  for (const category of REQUIRED_CATEGORIES) {
    if (!categories.has(category)) {
      fail(`missing required category ${category}`);
    }
  }

  if (process.exitCode) return;

  const critical = payload.cases.filter((item) => item.severity === 'critical').length;
  console.log('WINE AI SECURITY FOUNDATION OK');
  console.log(`Cases: ${payload.cases.length}`);
  console.log(`Critical: ${critical}`);
  console.log(`Categories: ${categories.size}`);
}

main();

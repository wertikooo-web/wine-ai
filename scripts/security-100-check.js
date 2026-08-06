'use strict';

const suite = require('../tests/security/cases-v2');
const allowedSeverity = new Set(['low', 'medium', 'high', 'critical']);

if (suite.caseCount !== 100 || suite.cases.length !== 100) {
  throw new Error(`Expected exactly 100 security cases, got ${suite.cases.length}`);
}

const ids = new Set();
const categories = new Map();
for (const testCase of suite.cases) {
  if (!testCase.id || ids.has(testCase.id)) throw new Error(`Duplicate or missing id: ${testCase.id}`);
  if (!allowedSeverity.has(testCase.severity)) throw new Error(`Invalid severity for ${testCase.id}`);
  if (!testCase.category || !testCase.expectedBehavior) throw new Error(`Incomplete case: ${testCase.id}`);
  ids.add(testCase.id);
  categories.set(testCase.category, (categories.get(testCase.category) || 0) + 1);
}

if (categories.size !== 10) throw new Error(`Expected 10 categories, got ${categories.size}`);
for (const [category, count] of categories) {
  if (count !== 10) throw new Error(`Expected 10 cases in ${category}, got ${count}`);
}

console.log('WINE AI Security Suite v2 validated');
console.log(`cases=${suite.cases.length} categories=${categories.size}`);
for (const [category, count] of categories) console.log(`${category}: ${count}`);

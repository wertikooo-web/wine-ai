'use strict';

const assert = require('assert');

// Thin wrapper around Node's built-in assert — kept here only so test
// files have one consistent import instead of each picking their own
// assertion style, matching the no-framework convention this project
// inherited (see AGENTS.md's "Required verification").
module.exports = {
    ok: assert.ok,
    equal: assert.strictEqual,
    deepEqual: assert.deepStrictEqual,
    match: (value, pattern, message) => assert.ok(pattern.test(value), message || `expected ${JSON.stringify(value)} to match ${pattern}`),
};

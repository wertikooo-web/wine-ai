'use strict';

const { buildIndex } = require('../src/knowledge/index');

const result = buildIndex();
console.log(`[knowledge:index] documents=${result.documentCount} chunks=${result.chunkCount} index=${result.indexFile}`);
if (result.errors.length > 0) {
    console.warn(`[knowledge:index] ${result.errors.length} document error(s):`);
    for (const error of result.errors) {
        console.warn(`  - ${error.sourceFile}: ${error.message}`);
    }
}

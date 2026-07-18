'use strict';

const { loadIndex, DEFAULT_INDEX_FILE } = require('../src/knowledge/index');
const { loadDocuments } = require('../src/knowledge/loader');

const index = loadIndex();
const { documents, errors } = loadDocuments();

let problems = 0;

if (index.chunk_count === 0) {
    console.warn('[knowledge:check] index is empty — run "npm run knowledge:index" first.');
    problems += 1;
}

for (const doc of documents) {
    if (doc.validation.missing.length > 0) {
        console.warn(`[knowledge:check] ${doc.sourceFile}: missing required metadata: ${doc.validation.missing.join(', ')}`);
        problems += 1;
    }
    if (doc.validation.unknown.length > 0) {
        console.warn(`[knowledge:check] ${doc.sourceFile}: unknown metadata field(s): ${doc.validation.unknown.join(', ')}`);
    }
}

for (const error of errors) {
    console.warn(`[knowledge:check] ${error.sourceFile}: ${error.message}`);
    problems += 1;
}

console.log(`[knowledge:check] index_file=${DEFAULT_INDEX_FILE} chunks=${index.chunk_count} documents=${documents.length} problems=${problems}`);
process.exitCode = problems > 0 ? 1 : 0;

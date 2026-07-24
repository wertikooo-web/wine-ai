'use strict';

// One-off (but reusable) maintenance script: re-fetches every already-
// approved/promoted discovered document through the CURRENT fetchPage()
// extraction logic and re-promotes it if the cleaned text changed.
//
// Why this is needed: fetchPage.js's extraction was improved twice today
// (paragraph-break preservation, then WordPress comment-form/byline/
// share-button boilerplate stripping) but those fixes only apply to pages
// fetched AFTER the fix shipped — the ~270 already-crawled
// wine-and-spirits.md pages (and anything else from the legacy crawler)
// are stuck with whatever extractMainText() produced when they were first
// fetched. Re-running the normal update cycle does NOT touch them: its
// dedup logic (updateCycle.js) only re-fetches pages already known to
// `listPages()`'s small seed list plus genuinely new discovered links,
// never the full backlog.
//
// This instead walks every record in the discovered-docs store (Postgres
// knowledge_documents table — retained permanently, url field intact,
// independent of promotion status) and re-runs the full
// fetch -> clean -> contentHash -> compare pipeline against each one.
// Content-hash comparison means this is naturally idempotent and cheap to
// re-run: an unchanged page (extraction produces the same cleaned text as
// before) is skipped, only genuinely different pages get re-promoted.
//
// Usage: node scripts/knowledge-reprocess-crawled.js
const path = require('path');
const store = require('../src/knowledge/discovered/store');
const { promote } = require('../src/knowledge/discovered/promote');
const { fetchPage } = require('../src/knowledge/crawler/fetchPage');
const { cleanText, contentHash, isSubstantial } = require('../src/knowledge/processor/clean');
const { buildIndex } = require('../src/knowledge/index');
const { DEFAULT_SOURCE_DIR } = require('../src/knowledge/loader');

async function main() {
    const docs = await store.loadAll();
    const approved = docs.filter((d) => d.status === 'approved' && /^https?:\/\//.test(d.url || ''));
    console.log(`Found ${approved.length} approved documents with a real URL to re-check.`);

    let changed = 0;
    let unchanged = 0;
    let failed = 0;
    const changedPaths = [];

    for (let i = 0; i < approved.length; i += 1) {
        const doc = approved[i];
        try {
            const fetched = await fetchPage(doc.url);
            const text = cleanText(fetched.text);
            if (!isSubstantial(text)) {
                failed += 1;
                console.log(`  [${i + 1}/${approved.length}] SKIP (too short after cleanup): ${doc.url}`);
                continue;
            }
            const newHash = contentHash(text);
            if (newHash === doc.contentHash) {
                unchanged += 1;
                continue;
            }
            const updatedDoc = {
                ...doc,
                text,
                contentHash: newHash,
                fetchedAt: fetched.fetchedAt,
                title: fetched.title || doc.title,
            };
            await store.save(updatedDoc);
            const fileName = promote(updatedDoc, DEFAULT_SOURCE_DIR);
            changedPaths.push(path.join(DEFAULT_SOURCE_DIR, fileName));
            changed += 1;
            console.log(`  [${i + 1}/${approved.length}] updated: ${fileName}`);
        } catch (err) {
            failed += 1;
            console.log(`  [${i + 1}/${approved.length}] FAILED (${doc.url}): ${err.message}`);
        }
    }

    console.log(`\nDone. changed=${changed} unchanged=${unchanged} failed=${failed}`);
    if (changed > 0) {
        const result = buildIndex();
        console.log(`Index rebuilt: documents=${result.documentCount} chunks=${result.chunkCount}`);
    }
    console.log('\nChanged file paths (for git add):');
    changedPaths.forEach((p) => console.log(p));
}

main().catch((err) => {
    console.error('Reprocess failed:', err);
    process.exitCode = 1;
});

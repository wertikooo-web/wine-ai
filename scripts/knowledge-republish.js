'use strict';

// Runs on every boot (see package.json's `prestart`), BEFORE building the
// search index. Railway containers are ephemeral: knowledge/source/*.md
// files written by promote() during a live crawl exist only on that one
// container's disk and are never committed back to git, so a fresh deploy
// silently reverted the live knowledge base to whatever was last committed
// — losing every document approved since. Postgres (discoveredStore) is
// the durable record of what's approved; this script re-derives the
// promoted files from it on every startup, the same self-healing re-
// promote loop updateCycle.js already ran after each crawl, just also run
// once at boot so a deploy alone can't lose approved content.
const discoveredStore = require('../src/knowledge/discovered/store');
const { promote } = require('../src/knowledge/discovered/promote');

async function main() {
    let approved;
    try {
        approved = (await discoveredStore.loadAll()).filter((doc) => doc.status === 'approved');
    } catch (error) {
        // Non-fatal: if Postgres is unreachable at boot, fall back to
        // whatever knowledge/source/ already has on disk (the git-committed
        // baseline) rather than blocking startup entirely.
        console.warn('[knowledge:republish] could not load discovered store, skipping:', error.message);
        return;
    }
    let republished = 0;
    for (const doc of approved) {
        try {
            promote(doc);
            republished += 1;
        } catch (error) {
            console.warn(`[knowledge:republish] failed to promote ${doc.id}:`, error.message);
        }
    }
    console.log(`[knowledge:republish] republished=${republished} approved_total=${approved.length}`);
}

main().catch((error) => {
    console.error('[knowledge:republish] unexpected error (continuing startup):', error);
});

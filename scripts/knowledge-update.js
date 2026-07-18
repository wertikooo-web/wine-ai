'use strict';

// CLI entry point for the update cycle — see src/knowledge/updateCycle.js
// for the actual logic (shared with the dashboard's manual-run HTTP route).
const { runUpdateCycle } = require('../src/knowledge/updateCycle');
const FORCE = /^(1|true|yes)$/i.test(String(process.env.KNOWLEDGE_UPDATE_FORCE || ''));

runUpdateCycle({ force: FORCE })
    .catch((error) => {
        console.error('[knowledge:update] FAILED:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        // A live pg.Pool has open sockets that would otherwise keep this
        // one-shot script's process alive indefinitely after the cycle
        // returns (this is a run-once cron/manual CLI job, not the
        // long-lived server).
        const db = require('../src/knowledge/db');
        if (db.isEnabled()) await db.getPool().end();
    });

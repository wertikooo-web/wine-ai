'use strict';

// Versioned corpus build CLI (PR2 — docs/architecture/BUILD_REGISTRY_DESIGN.md §6).
//
//   node scripts/build-versioned-corpus.js --dry-run            # read-only: no DB, no embedding API
//   node scripts/build-versioned-corpus.js [--resume]           # real run (DATABASE_URL required)
//   node scripts/build-versioned-corpus.js --manifest <path>    # alternate canonical manifest
//   node scripts/build-versioned-corpus.js --created-by <label> # operator label
//   node scripts/build-versioned-corpus.js --verify-committed <build_id>  # re-verify an existing build's
//                                                                          # committed rows (no refetch,
//                                                                          # no embeddings) and mark ready
//                                                                          # if all DB gates pass
//
// Deterministic: the same canonical manifest always yields the same build_id.
// Idempotent: re-running the same input re-verifies the same build; unchanged
// chunks/embeddings are skipped. The build reaches 'ready' only after all
// verification gates pass; it is NEVER activated here (no pointer write, no
// runtime wiring — activation is an explicit later operator action).

const builder = require('../src/buildRegistry/builder');
const registry = require('../src/buildRegistry/registry');

function parseArgs(argv) {
    const args = { dryRun: false, resume: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--resume') args.resume = true;
        else if (arg === '--manifest') args.manifestPath = argv[++i];
        else if (arg === '--created-by') args.createdBy = argv[++i];
        else if (arg === '--verify-committed') args.verifyCommitted = argv[++i];
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node scripts/build-versioned-corpus.js [--dry-run] [--resume] [--manifest <path>] [--created-by <label>] [--verify-committed <build_id>]');
        return;
    }

    const pool = args.dryRun ? null : registry.getPool();
    if (!args.dryRun && args.verifyCommitted) {
        const report = await builder.verifyCommittedBuild(pool, args.verifyCommitted);
        console.log(JSON.stringify(report, null, 2));
        await pool.end();
        return;
    }
    if (!args.dryRun && !pool) {
        console.error('error: DATABASE_URL is required for a real build (use --dry-run for a read-only simulation)');
        process.exit(1);
    }

    try {
        const report = await builder.runBuild({
            pool,
            manifestPath: args.manifestPath,
            dryRun: args.dryRun,
            resume: args.resume,
            createdBy: args.createdBy,
        });
        console.log(JSON.stringify(report, null, 2));
    } catch (err) {
        console.error(`build failed: ${err.code || 'ERROR'}: ${err.message}`);
        process.exit(1);
    } finally {
        if (pool && typeof pool.end === 'function') {
            await pool.end();
        }
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { parseArgs };

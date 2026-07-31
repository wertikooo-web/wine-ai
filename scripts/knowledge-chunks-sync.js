'use strict';

// Stage 1 migration import (docs/audits/PG_MIGRATION_PLAN.md): populate
// Postgres knowledge_chunks from the EXISTING filesystem knowledge base.
//
// This is a ONE-TIME MIGRATION IMPORT, not the permanent runtime path for
// filling Postgres. After this migration, new knowledge must enter Postgres
// through the pipeline (crawl / upload / extraction), never by re-importing
// files. Postgres is the single future source of truth; knowledge/source/*.md
// remains only as an import source / emergency fallback during the migration
// window.
//
// Usage:
//   node scripts/knowledge-chunks-sync.js            # real import (upsert)
//   node scripts/knowledge-chunks-sync.js --dry-run  # report only, no writes
//
// Requires DATABASE_URL (same as every other PG-backed knowledge path).
// Idempotent: re-running only updates chunks whose content hash changed.

const { loadDocuments, chunkDocument, DEFAULT_SOURCE_DIR } = require('../src/knowledge/loader');
const db = require('../src/knowledge/db');
const {
    importChunksToPostgres,
    verifyChunkIdStability,
    loadChunksFromPostgres,
} = require('../src/knowledge/chunkStore');

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Build chunks from the filesystem knowledge base and verify chunk-id
 * stability. Pure function (no DB) — shared by the CLI and tests.
 */
function buildChunksAndVerify({ sourceDir = DEFAULT_SOURCE_DIR, log = console.log } = {}) {
    const { documents, errors } = loadDocuments(sourceDir);
    if (errors.length) {
        log(`loadDocuments() reported ${errors.length} error(s) (continuing with the rest):`, errors.slice(0, 5));
    }
    const chunks = documents.flatMap(chunkDocument);

    const stability = verifyChunkIdStability(chunks);
    const rebuildIds = documents.flatMap(chunkDocument).map((c) => c.id);
    const deterministic = rebuildIds.every((id, i) => id === chunks[i].id);
    log('Chunk id stability:', JSON.stringify(stability, null, 2));
    log(`Chunk id deterministic across rebuild: ${deterministic}`);

    const stable = !stability.hasCollisions && stability.perSourceUnique && deterministic;
    return { documents, chunks, errors, stability, deterministic, stable };
}

async function runImport({ pool, dryRun = false, sourceDir = DEFAULT_SOURCE_DIR, log = console.log } = {}) {
    const built = buildChunksAndVerify({ sourceDir, log });
    if (!built.stable) {
        log('CHUNK ID STABILITY CHECK FAILED — aborting import to avoid corrupting the embeddings join.');
        return { ok: false, ...built, report: null };
    }

    const report = await importChunksToPostgres({ pool, chunks: built.chunks, dryRun });
    log('[knowledge-chunks-sync]', JSON.stringify(report));

    if (!dryRun) {
        const stored = await loadChunksFromPostgres(pool);
        const idMatch = stored.chunks.every((c, i) => c.id === built.chunks[i].id);
        log(`Post-import read-back: ${stored.chunks.length} chunks, id sequence matches source: ${idMatch}`);
        if (stored.chunks.length !== built.chunks.length || !idMatch) {
            log('POST-IMPORT READ-BACK MISMATCH — import did not persist all chunks.');
            return { ok: false, ...built, report, readBack: stored.chunks.length };
        }
        return { ok: true, ...built, report, readBack: stored.chunks.length };
    }

    return { ok: true, ...built, report };
}

async function main() {
    if (!db.isEnabled()) {
        console.error('DATABASE_URL not set — nothing to import against. Aborting.');
        process.exitCode = 1;
        return;
    }
    if (DRY_RUN) {
        console.log('[knowledge-chunks-sync] DRY RUN — no rows will be written.');
    }

    const pool = await db.init();
    if (!pool) {
        console.error('Postgres pool unavailable after init() — check PostgreSQL setup logs above.');
        process.exitCode = 1;
        return;
    }

    console.log(`Loading knowledge from ${DEFAULT_SOURCE_DIR}`);
    const result = await runImport({ pool, dryRun: DRY_RUN });
    if (!result.ok) {
        process.exitCode = 1;
        return;
    }

    console.log(`[knowledge-chunks-sync] ${DRY_RUN ? 'dry-run complete' : 'import complete'} — Postgres is ready to become the source of truth for search (Stage 2).`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('knowledge-chunks-sync failed:', err);
        process.exitCode = 1;
    });
}

module.exports = { buildChunksAndVerify, runImport };

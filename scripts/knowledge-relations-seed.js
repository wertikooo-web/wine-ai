'use strict';

// Phase 4 v1: idempotent import of grounded entity relations.
//
// Reads knowledge/relations/seed.v1.json — a hand-verified set of edges that
// are directly derivable from the approved winery profiles (knowledge/source/
// cricova.md, purcari.md) with full provenance. It never invents relations and
// never mass-backfills from guesses.
//
// Dry-run (no DB write):
//   node scripts/knowledge-relations-seed.js --dry-run
// Import (requires DATABASE_URL):
//   node scripts/knowledge-relations-seed.js
//
// Safe by construction: every seed row carries source_url/evidence; any row
// that would end up outside the v1 controlled vocabulary is reported as
// SKIPPED instead of written.

const fs = require('fs');
const path = require('path');
const db = require('../src/knowledge/db');
const relations = require('../src/knowledge/entityRelations');

const SEED_FILE = path.join(__dirname, '..', 'knowledge', 'relations', 'seed.v1.json');

function loadSeed() {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (!Array.isArray(seed)) throw new Error('seed file must contain an array of relations');
    return seed;
}

// Deterministic, idempotent part of a seed import. Returns counts + per-row
// outcome and reads/writes only through `pool` — testable against the in-memory
// Postgres engine without a live DATABASE_URL.
async function importSeed({ pool, seed }) {
    const counts = { total: seed.length, imported: 0, skipped: 0 };
    const byPredicate = {};
    const rows = [];

    for (const row of seed) {
        const { subject_id, subject_type, predicate, object_id, object_type, object_value, confidence, status, active, source_url, source_type, source_domain, evidence } = row;
        if (!relations.isRoadmapPredicate(predicate)) {
            counts.skipped += 1;
            rows.push({ subjectId: subject_id, predicate, outcome: 'skipped', reason: 'outside controlled vocabulary' });
            continue;
        }
        const created = await relations.createRelation({
            subjectId: subject_id,
            subjectType: subject_type,
            predicate,
            objectId: object_id || null,
            objectType: object_type || null,
            objectValue: object_value || null,
            confidence: confidence || 'medium',
            status,
            active: active !== false,
            sourceUrl: source_url,
            sourceType: source_type || 'general_web',
            sourceDomain: source_domain,
            evidence,
            changedBy: 'seed.v1',
        }, { pool });
        counts.imported += 1;
        byPredicate[created.predicate] = (byPredicate[created.predicate] || 0) + 1;
        rows.push({ subjectId: subject_id, predicate, outcome: 'imported', id: created.id, status: created.validation_status });
    }

    const stats = await relations.getRelationStats({ pool });
    return { imported: counts, stats, rows };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const seed = loadSeed();

    if (dryRun) {
        console.log(JSON.stringify({
            dry_run: true,
            seed_file: 'knowledge/relations/seed.v1.json',
            ...summarize(seed),
        }, null, 2));
        return;
    }

    if (!db.isEnabled()) throw new Error('DATABASE_URL is required for relation writes');
    const pool = db.getPool();

    const result = await importSeed({ pool, seed });
    console.log(JSON.stringify({ imported: result.imported, stats: result.stats }, null, 2));
}

function summarize(seed) {
    const byPredicate = {};
    const byStatus = {};
    const byType = {};
    for (const row of seed) {
        byPredicate[row.predicate] = (byPredicate[row.predicate] || 0) + 1;
        byStatus[row.status || 'needs_review'] = (byStatus[row.status || 'needs_review'] || 0) + 1;
        byType[row.subject_type] = (byType[row.subject_type] || 0) + 1;
        if (!relations.isRoadmapPredicate(row.predicate)) byPredicate.SKIPPED_UNCONTROLLED = (byPredicate.SKIPPED_UNCONTROLLED || 0) + 1;
    }
    return { relations: seed.length, by_predicate: byPredicate, by_status: byStatus, by_type: byType };
}

module.exports = { loadSeed, importSeed, summarize };

if (require.main === module) {
    main().then(() => process.exit(0)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

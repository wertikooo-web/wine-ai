'use strict';

// Phase 4 v1 seed verification: knowledge/relations/seed.v1.json and the
// scripts/knowledge-relations-seed.js import path.
//
// Covers:
//   - every seed row stays inside the roadmap vocabulary and the v1 publishable
//     subset (the invariant "no invented relations, controlled vocabulary");
//   - every seed row carries full provenance (source_url, evidence, status);
//   - import is idempotent (running twice yields the same DB state);
//   - import on the in-memory Postgres engine produces verified stats.

const fs = require('fs');
const path = require('path');
const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');
const relations = require('../src/knowledge/entityRelations');
const seedModule = require('../scripts/knowledge-relations-seed');

const SEED_FILE = path.join(__dirname, '..', 'knowledge', 'relations', 'seed.v1.json');

async function run() {
    // ------------------------------------------------------------------ //
    // 1. Seed file shape + vocabulary contract.
    // ------------------------------------------------------------------ //
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    t.ok(Array.isArray(seed), 'seed file is an array');
    t.ok(seed.length >= 5, `seed has enough relations to be meaningful (${seed.length})`);

    const unknownPredicates = seed.filter((row) => !relations.isRoadmapPredicate(row.predicate));
    t.equal(unknownPredicates.length, 0, 'every seed predicate is in the roadmap vocabulary');

    const nonPublishable = seed.filter((row) => !relations.isPublishable(row.predicate));
    t.equal(nonPublishable.length, 0, 'every seed predicate is v1-publishable (only built relations are seeded)');

    const withoutProvenance = seed.filter((row) => !row.source_url || !row.evidence || row.status !== 'approved');
    t.equal(withoutProvenance.length, 0, 'every seed row has source_url + evidence + approved status');

    const badSubjects = seed.filter((row) => !row.subject_id || row.subject_type !== 'winery');
    t.equal(badSubjects.length, 0, 'every seed relation originates from a winery subject');

    // ------------------------------------------------------------------ //
    // 2. Dry-run summary is deterministic and matches the file.
    // ------------------------------------------------------------------ //
    const summary = seedModule.summarize(seed);
    t.equal(summary.relations, seed.length, 'dry-run counts match the file');
    t.ok(summary.by_predicate.located_in > 0 && summary.by_predicate.produces > 0,
        'dry-run sees location and production relations');

    // ------------------------------------------------------------------ //
    // 3. Import on in-memory PG: stats + publishable count + no skips.
    // ------------------------------------------------------------------ //
    const pool = createMemoryPgPool();
    const result = await seedModule.importSeed({ pool, seed });
    t.equal(result.imported.total, seed.length, 'all seed rows imported');
    t.equal(result.imported.skipped, 0, 'nothing skipped on a clean v1 import');
    t.equal(result.imported.imported, seed.length, 'imported counter matches');
    t.equal(result.stats.total, seed.length, 'db row count matches seed size');
    // Every seeded predicate is publishable + approved + active => all live.
    t.equal(result.stats.publishable, seed.length, 'all seeded relations are publishable (approved+active)');

    const allRows = (await pool.query('SELECT * FROM entity_relations')).rows;
    t.ok(allRows.every((row) => row.active === true), 'all seeded rows active');
    t.ok(allRows.every((row) => relations.isPublishable(row.predicate)), 'only v1 predicates in db');

    // ------------------------------------------------------------------ //
    // 4. Idempotency: a second import leaves business state identical.
    //    (Timestamps legitimately refresh on upsert — compare everything else.)
    // ------------------------------------------------------------------ //
    const businessState = async (p) => {
        const rows = (await p.query('SELECT * FROM entity_relations')).rows
            .map((r) => ({
                id: r.id, subject_id: r.subject_id, predicate: r.predicate,
                object_id: r.object_id, object_value: r.object_value,
                validation_status: r.validation_status, active: r.active,
                source_url: r.source_url, evidence: r.evidence,
            }));
        return JSON.stringify(rows);
    };
    const before = await businessState(pool);
    const again = await seedModule.importSeed({ pool, seed });
    t.equal(again.imported.total, seed.length, 'second import processes same rows');
    const after = await businessState(pool);
    t.equal(after, before, 're-import is idempotent (identical business state)');
    t.equal(again.stats.total, seed.length, 'no duplicates after re-import');

    // ------------------------------------------------------------------ //
    // 5. Seed content sanity: the two wineries have the expected edges.
    // ------------------------------------------------------------------ //
    const cricova = await relations.queryRelations({ subjectId: 'cricova', active: true }, { pool });
    const purcari = await relations.queryRelations({ subjectId: 'purcari', active: true }, { pool });
    t.ok(cricova.some((r) => r.predicate === 'located_in' && r.object_id === 'codru'),
        'Cricova located_in Codru (matches approved profiles)');
    t.ok(cricova.some((r) => r.predicate === 'offers_tour'), 'Cricova offers_tour edge seeded');
    t.ok(purcari.some((r) => r.predicate === 'located_in' && r.object_id === 'stefan-voda'),
        'Purcari located_in Ștefan Vodă');
    t.ok(purcari.some((r) => r.predicate === 'produces' && r.object_value === 'Negru de Purcari'),
        'Purcari produces Negru de Purcari');
    t.ok(purcari.filter((r) => r.predicate === 'made_from').length >= 3,
        'Purcari made_from three grapes (Cabernet, Merlot, Fetească Neagră)');

    // ------------------------------------------------------------------ //
    // 6. Multi-condition exit condition, proven from the seed data: wineries
    //    in Štefan Vodă + who makes wine from Fetească Neagră there / who is
    //    located where — resolved purely from relation edges.
    // ------------------------------------------------------------------ //
    const stefanVoda = await relations.searchRelations('винодельни в Штефан-Водэ', { pool });
    t.ok(stefanVoda.length > 0, 'region query from seed data resolves');
    t.ok(stefanVoda.some((item) => item.provenance.entity_id === 'purcari'),
        'Purcari resolved as a Štefan Vodă winery from relations');

    return {};
}

module.exports = { run };
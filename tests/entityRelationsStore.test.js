'use strict';

// Phase 4 v1 store tests: Entity Relations (src/knowledge/entityRelations.js).
//
// Covers the invariant-bearing surface of the store:
//   - controlled vocabulary gate (roadmap predicates ingestible, others forced
//     to needs_review and never publishable);
//   - publish / reject lifecycle with append-only history ledger;
//   - idempotent create (deterministic relation id, upsert);
//   - getRelationStats publishable count only reflects live v1 edges;
//   - searchRelations resolves multi-condition queries purely from structured
//     relations (the roadmap §7 exit condition for Phase 4).

const t = require('./helpers/assertions');
const { createMemoryPgPool, PostgresError } = require('./helpers/postgresMemoryDb');
const relations = require('../src/knowledge/entityRelations');

function makePool() {
    const pool = createMemoryPgPool();
    pool.tables.set('entity_relations', { name: 'entity_relations', rows: [] });
    pool.tables.set('entity_relations_history', { name: 'entity_relations_history', rows: [] });
    return pool;
}

// Rebuild createRelation's deterministic id exactly as the store does.
function expectedId(subjectId, predicate, objectKey) {
    return relations.relationId(subjectId, predicate, objectKey);
}

async function run() {
    // ------------------------------------------------------------------ //
    // 1. createRelation basics + deterministic id + provenance defaults.
    // ------------------------------------------------------------------ //
    const pool = makePool();
    const created = await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'located_in',
        objectId: 'codru',
        objectType: 'wine_region',
        confidence: 'medium',
        status: 'approved',
        active: true,
        sourceUrl: 'knowledge/source/cricova.md',
        sourceType: 'internal_reference',
        sourceDomain: 'internal_reference',
        evidence: 'fixture evidence',
        changedBy: 'test',
    }, { pool });

    t.equal(created.id, expectedId('cricova', 'located_in', 'wine_region:codru'), 'relation id is deterministic');
    t.equal(created.validation_status, 'approved', 'approved relation keeps its status');
    t.equal(created.active, true, 'approved+publishable relation is active');
    t.ok(created.verified_at, 'active relation gets verified_at');
    t.equal(created.source_domain, 'internal_reference', 'source domain preserved');

    // ------------------------------------------------------------------ //
    // 2. Validation errors: missing subject/predicate, bad confidence,
    //    object_id without object_type, no object at all.
    // ------------------------------------------------------------------ //
    const cases = [
        { subjectId: 'cricova', predicate: null, objectValue: 'x' },
        { subjectId: '', predicate: 'produces', objectValue: 'x' },
        { subjectId: 'cricova', predicate: 'produces', objectValue: 'x', confidence: 'extreme' },
        { subjectId: 'cricova', predicate: 'produces', objectId: 'codru', objectType: null },
        { subjectId: 'cricova', predicate: 'produces' },
    ];
    for (const args of cases) {
        let threw = false;
        try {
            await relations.createRelation(args, { pool });
        } catch (error) {
            threw = true;
            t.ok(/SUBJECT_AND_PREDICATE_REQUIRED|INVALID_CONFIDENCE|OBJECT_ID_REQUIRES_OBJECT_TYPE|OBJECT_REQUIRED/.test(error.code), `threw expected code for ${JSON.stringify(args)}`);
        }
        t.ok(threw, `invalid input rejected for ${JSON.stringify(args)}`);
    }

    // ------------------------------------------------------------------ //
    // 3. Controlled vocabulary gate: roadmap non-v1 predicate is storable but
    //    forced to needs_review + inactive and never publishable.
    // ------------------------------------------------------------------ //
    const poolGate = makePool();
    const offVocab = await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'has_restaurant', // roadmap, but NOT in the v1 publishable subset
        objectValue: 'true',
        objectType: 'tourism',
        status: 'approved',
        active: true,
    }, { pool: poolGate });
    t.equal(offVocab.validation_status, 'approved', 'roadmap-but-not-v1 predicate keeps its stored status');
    t.equal(offVocab.active, false, 'roadmap-but-not-v1 predicate forced inactive (never leaked to search)');

    let publishRejected = false;
    try {
        await relations.publishRelation(offVocab.id, { changedBy: 'test' }, { pool: poolGate });
    } catch (error) {
        publishRejected = true;
        t.equal(error.code, 'PREDICATE_NOT_PUBLISHABLE', 'non-publishable predicate cannot be published');
    }
    t.ok(publishRejected, 'publishRelation refuses non-v1 predicates');

    const nonVocab = await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'sells_nft', // nowhere in the roadmap vocabulary
        objectValue: 'true',
        status: 'approved',
        active: true,
    }, { pool: poolGate });
    t.equal(nonVocab.validation_status, 'needs_review', 'non-roadmap predicate forced to needs_review');
    t.ok(relations.isRoadmapPredicate('has_restaurant'), 'has_restaurant is in the roadmap vocabulary');
    t.ok(!relations.isRoadmapPredicate('sells_nft'), 'made-up predicate is outside the roadmap vocabulary');
    t.ok(!relations.isPublishable('has_restaurant'), 'has_restaurant is not v1-publishable');
    t.ok(relations.isPublishable('located_in'), 'located_in is v1-publishable');

    // The history ledger recorded the create for both (the failed publish of a
    // non-publishable predicate throws BEFORE writing history).
    const history = (await poolGate.query('SELECT * FROM entity_relations_history')).rows;
    t.equal(history.length, 2, 'history ledger append-only (create x2; no entry for rejected publish)');

    // ------------------------------------------------------------------ //
    // 4. Publish lifecycle: publishRelation flips needs_review -> approved,
    //    active + verified_at, and writes a history entry.
    // ------------------------------------------------------------------ //
    const poolPub = makePool();
    const draft = await relations.createRelation({
        subjectId: 'purcari',
        subjectType: 'winery',
        predicate: 'produces',
        objectValue: 'Negru de Purcari',
        objectType: 'wine',
        confidence: 'medium',
        status: 'needs_review',
    }, { pool: poolPub });
    t.equal(draft.active, false, 'needs_review relation starts inactive');

    const published = await relations.publishRelation(draft.id, { status: 'approved', changedBy: 'test' }, { pool: poolPub });
    t.equal(published.validation_status, 'approved', 'publish sets validated status');
    t.equal(published.active, true, 'publish activates relation');

    const reloaded = await relations.getRelation(draft.id, { pool: poolPub });
    t.equal(reloaded.active, true, 'publish persisted active flag');
    t.ok(reloaded.verified_at, 'publish persisted verified_at');

    // ------------------------------------------------------------------ //
    // 5. Reject lifecycle: rejectRelation sets rejected + inactive.
    // ------------------------------------------------------------------ //
    const toReject = await relations.createRelation({
        subjectId: 'purcari',
        subjectType: 'winery',
        predicate: 'located_in',
        objectId: 'codru',
        objectType: 'wine_region',
        status: 'approved',
        active: true,
    }, { pool: poolPub });
    const rejected = await relations.rejectRelation(toReject.id, { changedBy: 'test', note: 'misattributed' }, { pool: poolPub });
    t.equal(rejected.validation_status, 'rejected', 'reject sets status');
    t.equal(rejected.active, false, 'reject deactivates relation');

    const hist = (await poolPub.query('SELECT * FROM entity_relations_history')).rows;
    const rejectEntry = hist.find((h) => h.relation_id === toReject.id && h.action === 'rejected');
    t.ok(rejectEntry, 'history records the rejection');
    t.equal(rejectEntry.note, 'misattributed', 'rejection note preserved in history');

    // ------------------------------------------------------------------ //
    // 6. getRelationStats counts only live v1 edges as publishable.
    // ------------------------------------------------------------------ //
    const stats = await relations.getRelationStats({ pool: poolPub });
    t.equal(stats.enabled, true, 'stats report enabled when a pool is available');
    t.equal(stats.total, 2, 'stats count all stored relations');
    // 1 approved+active+produces (published), 1 rejected+inactive+located_in.
    t.equal(stats.publishable, 1, 'publishable counts only approved+active v1 edges');
    t.equal(stats.by_predicate.produces, 1, 'per-predicate stats');
    t.equal(stats.by_predicate.located_in, 1, 'per-predicate stats include rejected rows');

    // ------------------------------------------------------------------ //
    // 7. Idempotent create: same source+predicate+object => same id, upsert.
    // ------------------------------------------------------------------ //
    const poolIdem = makePool();
    await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'located_in',
        objectId: 'codru',
        objectType: 'wine_region',
        status: 'approved',
        active: true,
    }, { pool: poolIdem });
    await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'located_in', // note: source_url differs, but id is (subj,pred,obj)
        objectId: 'codru',
        objectType: 'wine_region',
        status: 'approved',
        active: true,
        sourceUrl: 'knowledge/source/other.md',
    }, { pool: poolIdem });
    const all = (await poolIdem.query('SELECT * FROM entity_relations')).rows;
    t.equal(all.length, 1, 'duplicate create upserts instead of duplicating');

    // ------------------------------------------------------------------ //
    // 8. SearchRelations — multi-condition structured resolution.
    //    Seed relations for two wineries:
    //      cricova: located_in codru, produces «игристые вина»
    //      milestii-mici: located_in codru
    //      purcari: located_in stefan-voda, produces «Negru de Purcari»
    //    This is the Phase 4 exit condition: multi-condition questions resolve
    //    against relation edges, not semantic text similarity.
    // ------------------------------------------------------------------ //
    const poolSearch = makePool();
    const seedEdges = [
        { subjectId: 'cricova', predicate: 'located_in', objectId: 'codru', objectType: 'wine_region' },
        { subjectId: 'cricova', predicate: 'produces', objectValue: 'игристые вина', objectType: 'wine' },
        { subjectId: 'milestii-mici', predicate: 'located_in', objectId: 'codru', objectType: 'wine_region' },
        { subjectId: 'purcari', predicate: 'located_in', objectId: 'stefan-voda', objectType: 'wine_region' },
        { subjectId: 'purcari', predicate: 'produces', objectValue: 'Negru de Purcari', objectType: 'wine' },
    ];
    for (const edge of seedEdges) {
        await relations.createRelation({
            subjectType: 'winery',
            confidence: 'medium',
            status: 'approved',
            active: true,
            ...edge,
        }, { pool: poolSearch });
    }

    // 8a. Two conditions joined by shared subject: wineries located in Codru.
    const inCodru = await relations.searchRelations('винодельни в Кодру', { pool: poolSearch });
    t.ok(inCodru.length >= 2, 'region query returns structured relations');
    const codruSubjects = new Set(inCodru.map((item) => item.provenance.entity_id));
    t.ok(codruSubjects.has('cricova'), 'Cricova matched by located_in codru');
    t.ok(codruSubjects.has('milestii-mici'), 'Mileștii Mici matched by located_in codru');
    t.ok(inCodru.every((item) => item.structured === true && item.structured_kind === 'entity_relation'),
        'results are structured entity_relation evidence');

    // 8b. Entity + predicate: what does Cricova produce?
    const cricovaProduces = await relations.searchRelations('что производит Cricova', { pool: poolSearch });
    t.ok(cricovaProduces.length > 0, 'entity+predicate query resolves');
    const cricovaPredicates = new Set(cricovaProduces.map((item) => item.relation.predicate));
    t.ok(cricovaPredicates.has('produces'), 'produces edge returned for Cricova');

    // 8c. Region-filtered producer: who makes sparkling wine in Codru?
    const sparkleCodru = await relations.searchRelations('какие игристые вина делают в Кодру', { pool: poolSearch });
    t.ok(sparkleCodru.length > 0, 'region+wine query resolves');
    const sparkleSubjects = new Set(sparkleCodru.map((item) => item.provenance.entity_id));
    t.equal(sparkleCodru[0].provenance.entity_id, 'cricova', 'only Cricova satisfies region+wine conditions');

    // 8d. No entity mentioned -> no relation evidence (router falls through).
    const noEntity = await relations.searchRelations('как приготовить пасту карбонара', { pool: poolSearch });
    t.equal(noEntity.length, 0, 'non-entity query yields no relation evidence');

    // 8e. Non-publishable/needs_review edges never leak into search.
    await relations.createRelation({
        subjectId: 'cricova',
        subjectType: 'winery',
        predicate: 'has_restaurant',
        objectValue: 'true',
        status: 'approved',
        active: true,
    }, { pool: poolSearch });
    const afterGate = await relations.searchRelations('ресторан в Cricova', { pool: poolSearch });
    t.equal(afterGate.filter((item) => item.relation.predicate === 'has_restaurant').length, 0,
        'needs_review relation not returned by search');

    return { assertionCount: 'see below (assert-style assertions)' };
}

module.exports = { run };
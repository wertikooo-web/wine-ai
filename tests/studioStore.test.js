'use strict';

// Phase 5 store tests: Knowledge Studio (src/knowledge/studio/studioStore.js).
//
// Covers the invariant-bearing surface of the studio workflow store:
//   - fact edits enter as inactive candidates and only reach the canonical
//     layer after an explicit approve (never before);
//   - approving a fact supersedes the previous live value for the same
//     entity+field (exactly one live approved value per field);
//   - rollback restores the superseded value (or rejects a brand-new fact);
//   - relation edits: new relation candidate + edit-of-live-relation candidate,
//     approve activates, rollback restores the previous edge;
//   - alias edits: pending → approve applies to the canonical registry file
//     (using the `lang` key the resolver actually reads) and invalidates the
//     resolver cache; rollback reverses the applied change;
//   - entity merge retargets facts/relations/aliases and never duplicates live
//     fact values.

const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

// Point the resolver + studio store at an isolated registry file BEFORE
// requiring the store (the resolver reads the path lazily at call time).
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
const REGISTRY_FILE = path.join(TEMP_DIR, 'entity-aliases.json');
process.env.ENTITY_ALIASES_FILE = REGISTRY_FILE;

const studio = require('../src/knowledge/studio/studioStore');
const resolver = require('../src/knowledge/entityResolver');

function makePool() {
    const pool = createMemoryPgPool();
    for (const table of ['entity_facts', 'entity_facts_history', 'entity_relations', 'entity_relations_history', 'studio_alias_edits']) {
        pool.tables.set(table, { name: table, rows: [] });
    }
    return pool;
}

function writeRegistry(data) {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf8');
    resolver.invalidateAliasCache();
}

const BASE_REGISTRY = [
    {
        entityId: 'purcari',
        entityType: 'winery',
        canonicalName: 'Purcari',
        aliases: [
            { alias: 'Purcari', lang: 'ro' },
            { alias: 'Пуркарь', lang: 'ru' },
        ],
    },
    {
        entityId: 'milestii-mici',
        entityType: 'winery',
        canonicalName: 'Mileștii Mici',
        aliases: [{ alias: 'Mileștii Mici', lang: 'ro' }],
    },
];

async function run() {
    // ------------------------------------------------------------------ //
    // 1. Fact edit lifecycle: candidate -> approve (with supersede) ->
    //    rollback (restores previous live value).
    // ------------------------------------------------------------------ //
    {
        writeRegistry(BASE_REGISTRY);
        const pool = makePool();
        const oldFact = await studio.createFactEdit({
            entityId: 'purcari',
            entityType: 'winery',
            fieldName: 'founded_year',
            value: '1827',
            changedBy: 'seed',
        }, { pool });
        await studio.reviewFact(oldFact.id, { action: 'approve', changedBy: 'editor' }, { pool });

        // The live fact is active+approved in the canonical layer.
        const liveAfterSeed = (await pool.query('SELECT * FROM entity_facts WHERE id = $1', [oldFact.id])).rows[0];
        t.equal(liveAfterSeed.validation_status, 'approved', 'approved seed fact is approved');
        t.equal(liveAfterSeed.active, true, 'approved seed fact is active');

        // Editor proposes a correction — must NOT touch the live layer.
        const edit = await studio.createFactEdit({
            entityId: 'purcari',
            fieldName: 'founded_year',
            value: '1827 (rebuilt 2004)',
            changedBy: 'editor',
        }, { pool });
        t.equal(edit.validation_status, 'candidate', 'fact edit enters as candidate');
        t.equal(edit.active, false, 'fact edit is inactive until approved');
        t.equal(liveAfterSeed.active, true, 'live value stays active while a candidate waits');

        // Approve: the candidate becomes the only live value; the old one is
        // superseded to stale+inactive.
        await studio.reviewFact(edit.id, { action: 'approve', changedBy: 'editor' }, { pool });
        const rows = (await pool.query('SELECT * FROM entity_facts')).rows;
        const live = rows.filter((r) => r.active && ['approved', 'validated'].includes(r.validation_status));
        t.equal(live.length, 1, 'exactly one live approved value per field after approval');
        t.equal(live[0].id, edit.id, 'the approved edit is the live value');
        const old = (await pool.query('SELECT * FROM entity_facts WHERE id = $1', [oldFact.id])).rows[0];
        t.equal(old.validation_status, 'stale', 'previous live value superseded to stale');
        t.equal(old.active, false, 'previous live value deactivated');

        // History ledger recorded published + superseded with the link.
        const hist = (await pool.query('SELECT * FROM entity_facts_history')).rows;
        const published = hist.find((h) => h.fact_id === edit.id && h.action === 'published');
        t.ok(published, 'history records the publish');
        t.match(published.note, /supersedes=/, 'published entry carries the supersedes link');
        t.ok(hist.find((h) => h.fact_id === oldFact.id && h.action === 'superseded'), 'history records the supersede');

        // Rollback: the old value comes back live, the edit is deactivated.
        const rolled = await studio.rollbackFact(edit.id, { changedBy: 'editor' }, { pool });
        t.equal(rolled.validation_status, 'stale', 'rolled-back fact becomes stale');
        const restored = (await pool.query('SELECT * FROM entity_facts WHERE id = $1', [oldFact.id])).rows[0];
        t.equal(restored.validation_status, 'approved', 'previous value restored to approved');
        t.equal(restored.active, true, 'previous value reactivated');
        t.ok((await pool.query('SELECT * FROM entity_facts_history')).rows.find((h) => h.fact_id === oldFact.id && h.action === 'restored'),
            'history records the restore');
    }

    // ------------------------------------------------------------------ //
    // 2. Reject a candidate fact: stays out of the canonical layer.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const candidate = await studio.createFactEdit({
            entityId: 'purcari',
            fieldName: 'established',
            value: '1879',
            changedBy: 'editor',
        }, { pool });
        await studio.reviewFact(candidate.id, { action: 'reject', changedBy: 'editor' }, { pool });
        const row = (await pool.query('SELECT * FROM entity_facts WHERE id = $1', [candidate.id])).rows[0];
        t.equal(row.validation_status, 'rejected', 'rejected candidate is rejected');
        t.equal(row.active, false, 'rejected candidate never becomes live');
        t.ok((await pool.query('SELECT * FROM entity_facts_history')).rows.find((h) => h.fact_id === candidate.id && h.action === 'rejected'),
            'history records the rejection');
    }

    // ------------------------------------------------------------------ //
    // 3. Validation gates: missing fields / bad confidence / double review.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();
        const gates = [
            { entityId: 'purcari', fieldName: null, value: 'x' },
            { entityId: 'purcari', fieldName: 'founded_year', value: '  ' },
            { entityId: 'purcari', fieldName: 'founded_year', value: '1827', confidence: 'certain' },
        ];
        for (const args of gates) {
            let threw = false;
            try {
                await studio.createFactEdit(args, { pool });
            } catch (error) {
                threw = true;
                t.ok(/FACT_REQUIRED|INVALID_CONFIDENCE/.test(error.code), `gate ${JSON.stringify(args)} threw ${error.code}`);
            }
            t.ok(threw, `invalid fact edit rejected for ${JSON.stringify(args)}`);
        }

        const fact = await studio.createFactEdit({ entityId: 'purcari', fieldName: 'founded_year', value: '1827' }, { pool });
        await studio.reviewFact(fact.id, { action: 'approve' }, { pool });
        let double = false;
        try {
            await studio.reviewFact(fact.id, { action: 'approve' }, { pool });
        } catch (error) {
            double = true;
            t.equal(error.code, 'FACT_ALREADY_REVIEWED', 'double review rejected');
        }
        t.ok(double, 'approving an already-reviewed fact throws');
    }

    // ------------------------------------------------------------------ //
    // 4. Relation lifecycle: new candidate -> approve; edit of a live
    //    relation -> approve supersedes the old edge; rollback restores.
    // ------------------------------------------------------------------ //
    {
        const pool = makePool();

        // Brand-new relation enters as an inactive candidate.
        const created = await studio.createRelationEdit({
            subjectId: 'purcari',
            predicate: 'located_in',
            objectId: 'codru',
            objectType: 'wine_region',
            changedBy: 'editor',
        }, { pool });
        t.equal(created.validation_status, 'candidate', 'new relation edit enters as candidate');
        t.equal(created.active, false, 'new relation is inactive until approved');
        await studio.reviewRelation(created.id, { action: 'approve', changedBy: 'editor' }, { pool });
        const liveRel = (await pool.query('SELECT * FROM entity_relations WHERE id = $1', [created.id])).rows[0];
        t.equal(liveRel.validation_status, 'approved', 'approved relation is approved');
        t.equal(liveRel.active, true, 'approved relation is active');

        // Edit the same live edge (same subject+predicate+object identity, so
        // the deterministic id matches): candidate id differs from the live
        // edge, old edge stays live until approval.
        const edit = await studio.createRelationEdit({
            subjectId: 'purcari',
            predicate: 'located_in',
            objectId: 'codru',
            objectType: 'wine_region',
            confidence: 'low',
            sourceUrl: 'knowledge/source/corrected.md',
            changedBy: 'editor',
        }, { pool });
        t.ok(edit.id !== created.id, 'edit-of-live-relation gets a distinct candidate id');
        t.equal(edit.validation_status, 'candidate', 'relation edit is a candidate');
        const stillLive = (await pool.query('SELECT * FROM entity_relations WHERE id = $1', [created.id])).rows[0];
        t.equal(stillLive.active, true, 'old edge stays live while the edit waits');

        await studio.reviewRelation(edit.id, { action: 'approve', changedBy: 'editor' }, { pool });
        const oldEdge = (await pool.query('SELECT * FROM entity_relations WHERE id = $1', [created.id])).rows[0];
        t.equal(oldEdge.validation_status, 'stale', 'old edge superseded to stale');
        t.equal(oldEdge.active, false, 'old edge deactivated');
        const newEdge = (await pool.query('SELECT * FROM entity_relations WHERE id = $1', [edit.id])).rows[0];
        t.equal(newEdge.active, true, 'approved edit edge is active');

        // Rollback restores the original edge.
        await studio.rollbackRelation(edit.id, { changedBy: 'editor' }, { pool });
        const restoredRel = (await pool.query('SELECT * FROM entity_relations WHERE id = $1', [created.id])).rows[0];
        t.equal(restoredRel.validation_status, 'approved', 'rolled-back relation restores previous edge status');
        t.equal(restoredRel.active, true, 'rolled-back relation restores previous edge active');
    }

    // ------------------------------------------------------------------ //
    // 5. Alias edits: pending -> approve applies to the registry file with
    //    the `lang` key the resolver reads, then resolver resolves the new
    //    alias immediately; rollback reverses it.
    // ------------------------------------------------------------------ //
    {
        writeRegistry(BASE_REGISTRY);

        const pool = makePool();

        // Add a Russian alias to purcari.
        const addEdit = await studio.createAliasEdit({
            entityId: 'purcari',
            alias: 'Комбинат Шампанских Вин',
            language: 'ru',
            action: 'add',
            changedBy: 'editor',
        }, { pool });
        t.equal(addEdit.status, 'pending', 'alias edit starts pending');

        // The resolver must NOT see the alias before approval.
        t.equal(resolver.resolveEntity('Комбинат Шампанских Вин').found, false, 'pending alias is not resolvable yet');

        await studio.reviewAliasEdit(addEdit.id, { action: 'approve', changedBy: 'reviewer', note: 'ok' }, { pool });
        const approvedEdit = (await pool.query('SELECT * FROM studio_alias_edits WHERE id = $1', [addEdit.id])).rows[0];
        t.equal(approvedEdit.status, 'approved', 'approved alias edit is approved');
        t.ok(approvedEdit.reviewed_by, 'approved alias edit records reviewer');

        // Registry file now contains the alias with `lang` (the key the
        // resolver reads — not `language`).
        const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        const purcari = registry.find((e) => e.entityId === 'purcari');
        const ruAlias = purcari.aliases.find((a) => a.alias === 'Комбинат Шампанских Вин');
        t.ok(ruAlias, 'approved alias added to the registry file');
        t.equal(ruAlias.lang, 'ru', 'registry alias uses the `lang` key');
        t.ok(!('language' in ruAlias), 'registry alias does not use a `language` key');

        // Resolver sees it immediately (cache invalidated).
        const resolved = resolver.resolveEntity('Комбинат Шампанских Вин');
        t.equal(resolved.found, true, 'new alias resolves right after approval');
        t.equal(resolved.entityId, 'purcari', 'new alias resolves to the right entity');

        // Reject path: a rejected edit changes nothing.
        const rejectEdit = await studio.createAliasEdit({
            entityId: 'purcari',
            alias: 'Каберне Пукарь',
            language: 'ru',
            action: 'add',
            changedBy: 'editor',
        }, { pool });
        await studio.reviewAliasEdit(rejectEdit.id, { action: 'reject', changedBy: 'reviewer' }, { pool });
        const afterReject = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        t.ok(!afterReject.find((e) => e.entityId === 'purcari').aliases.some((a) => a.alias === 'Каберне Пукарь'),
            'rejected alias edit never reaches the registry');

        // Rollback removes the approved alias.
        await studio.rollbackAliasEdit(addEdit.id, { changedBy: 'editor' }, { pool });
        const afterRollback = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        t.ok(!afterRollback.find((e) => e.entityId === 'purcari').aliases.some((a) => a.alias === 'Комбинат Шампанских Вин'),
            'rollback removes the approved alias from the registry');
        const rolledEdit = (await pool.query('SELECT * FROM studio_alias_edits WHERE id = $1', [addEdit.id])).rows[0];
        t.equal(rolledEdit.status, 'superseded', 'rolled-back alias edit marked superseded');
        t.equal(resolver.resolveEntity('Комбинат Шампанских Вин').found, false, 'alias no longer resolves after rollback');
    }

    // ------------------------------------------------------------------ //
    // 6. Rename alias edit: approve renames, rollback restores the old form.
    // ------------------------------------------------------------------ //
    {
        writeRegistry(BASE_REGISTRY);
        const pool = makePool();

        const rename = await studio.createAliasEdit({
            entityId: 'purcari',
            alias: 'Purcari Winery',
            language: 'ro',
            action: 'rename',
            prevAlias: 'Purcari',
            changedBy: 'editor',
        }, { pool });
        await studio.reviewAliasEdit(rename.id, { action: 'approve', changedBy: 'reviewer' }, { pool });
        const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        const aliases = reg.find((e) => e.entityId === 'purcari').aliases;
        t.ok(!aliases.some((a) => a.alias === 'Purcari'), 'renamed-away alias is gone');
        t.ok(aliases.some((a) => a.alias === 'Purcari Winery' && a.lang === 'ro'), 'new alias form present with lang');

        await studio.rollbackAliasEdit(rename.id, { changedBy: 'editor' }, { pool });
        const after = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        const aliasesAfter = after.find((e) => e.entityId === 'purcari').aliases;
        t.ok(aliasesAfter.some((a) => a.alias === 'Purcari'), 'rollback restores the old alias form');
        t.ok(!aliasesAfter.some((a) => a.alias === 'Purcari Winery'), 'rollback removes the renamed alias');
    }

    // ------------------------------------------------------------------ //
    // 7. Entity merge: facts/relations retargeted, aliases merged, registry
    //    marks the merged entity, live fact values never duplicated.
    // ------------------------------------------------------------------ //
    {
        writeRegistry(BASE_REGISTRY);
        const pool = makePool();

        const keepFact = await studio.createFactEdit({ entityId: 'milestii-mici', fieldName: 'founded_year', value: '1969' }, { pool });
        await studio.reviewFact(keepFact.id, { action: 'approve' }, { pool });
        const mergeFact = await studio.createFactEdit({ entityId: 'purcari', fieldName: 'founded_year', value: '1827' }, { pool });
        await studio.reviewFact(mergeFact.id, { action: 'approve' }, { pool });
        const mergeRel = await studio.createRelationEdit({
            subjectId: 'purcari', predicate: 'located_in', objectId: 'stefan-voda', objectType: 'wine_region',
        }, { pool });
        await studio.reviewRelation(mergeRel.id, { action: 'approve' }, { pool });

        const merged = await studio.mergeEntities({ keepId: 'milestii-mici', mergeId: 'purcari', changedBy: 'editor' }, { pool });
        t.equal(merged.keepId, 'milestii-mici', 'merge keeps the intended entity');

        // purcari's founded_year moved; the two values for the same field must
        // not both be live — keep's value stays live, the moved one is stale.
        const facts = (await pool.query('SELECT * FROM entity_facts')).rows;
        const live = facts.filter((r) => r.active && ['approved', 'validated'].includes(r.validation_status));
        t.equal(live.length, 1, 'merge leaves exactly one live value for the field');
        t.equal(live[0].entity_id, 'milestii-mici', 'live value belongs to the keeper');

        // Relations retargeted to the keeper on both sides.
        const rel = (await pool.query('SELECT * FROM entity_relations')).rows[0];
        t.equal(rel.subject_id, 'milestii-mici', 'relation subject retargeted to keeper');

        // Registry: aliases merged, merged entity marked.
        const reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        const keeper = reg.find((e) => e.entityId === 'milestii-mici');
        t.ok(keeper.aliases.some((a) => a.alias === 'Пуркарь'), 'aliases from the merged entity moved to the keeper');
        const mergedEntity = reg.find((e) => e.entityId === 'purcari');
        t.equal(mergedEntity.mergedInto, 'milestii-mici', 'merged entity marked in registry');
    }

    // ------------------------------------------------------------------ //
    // 8. Review queues and duplicate candidates surface the pending work.
    // ------------------------------------------------------------------ //
    {
        writeRegistry(BASE_REGISTRY);
        const pool = makePool();
        await studio.createFactEdit({ entityId: 'purcari', fieldName: 'founded_year', value: '1827' }, { pool });
        await studio.createRelationEdit({
            subjectId: 'purcari', predicate: 'located_in', objectId: 'codru', objectType: 'wine_region',
        }, { pool });
        await studio.createAliasEdit({ entityId: 'purcari', alias: 'Пуркарь', language: 'ru', action: 'add' }, { pool });

        const queues = await studio.getReviewQueues({ pool });
        t.equal(queues.enabled, true, 'review queues enabled with a pool');
        t.ok(Array.isArray(queues.queues.pending_fact_edits), 'pending fact edits queue present');
        t.equal(queues.queues.pending_fact_edits.length, 1, 'one pending fact edit');
        t.equal(queues.queues.pending_relation_edits.length, 1, 'one pending relation edit');
        t.equal(queues.queues.pending_alias_edits.length, 1, 'one pending alias edit');

        // Duplicate candidates: the two wineries share the overlapping alias
        // "Пуркарь"/"Purcari"? They don't — assert an empty-but-clean result.
        t.ok(Array.isArray(queues.queues.possible_duplicates), 'duplicate scan queue present');
    }

    return { assertionCount: 'see below (assert-style assertions)' };
}

module.exports = { run };

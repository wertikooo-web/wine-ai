'use strict';

// Phase 5 end-to-end workflow proof through the production read path.
//
// This is the Definition-of-Done workflow, executed against the same store and
// the same canonical read path the running server uses:
//
//   edit → review/approve → answer uses the knowledge → rollback
//
// assertions:
//   - a studio fact enters as an inactive candidate and is INVISIBLE to
//     layeredRouter.searchCanonical (answer path) until approved;
//   - after approve the same fact is returned by searchCanonical with full
//     provenance (fact_id, validation_status='approved', verified_at), i.e.
//     the answer path now uses it and the Answer Audit surfaces it via
//     claim provenance;
//   - rollback removes it from the canonical layer again (brand-new fact) or
//     restores the superseded live value (edit of an existing fact).
//
// Same for a relation: candidate invisible → approved visible with
// relation_id in provenance → rollback removes/restores.
//
// Sign-of-life: a production editor never touches PG/seed scripts; the
// workflow verified here is exactly what /api/studio/* + /knowledge-studio
// drive through studioStore.

const fs = require('fs');
const os = require('os');
const path = require('path');

const t = require('./helpers/assertions');
const { createMemoryPgPool } = require('./helpers/postgresMemoryDb');

let assertionCount = 0;
const wrapped = {
    ok: (value, message) => { assertionCount += 1; t.ok(value, message); },
    equal: (actual, expected, message) => { assertionCount += 1; t.equal(actual, expected, message); },
    deepEqual: (actual, expected, message) => { assertionCount += 1; t.deepEqual(actual, expected, message); },
    match: (value, pattern, message) => { assertionCount += 1; t.match(value, pattern, message); },
};

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workflow-'));
const REGISTRY_FILE = path.join(TEMP_DIR, 'entity-aliases.json');
process.env.ENTITY_ALIASES_FILE = REGISTRY_FILE;

const studio = require('../src/knowledge/studio/studioStore');
const resolver = require('../src/knowledge/entityResolver');
const layeredRouter = require('../src/knowledge/layeredRouter');

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

async function run() {
    const pool = makePool();
    writeRegistry([
        { entityId: 'purcari', entityType: 'winery', canonicalName: 'Purcari', aliases: [{ alias: 'Purcari', lang: 'ro' }] },
        { entityId: 'albastre-de-purcari', entityType: 'wine', canonicalName: 'Alb de Purcari', aliases: [] },
    ]);

    const db = require('../src/knowledge/db');
    const originalGetPool = db.getPool;
    db.getPool = () => pool;

    try {
        // ---------------- 1. edit: brand-new fact enters as candidate -------
        const fact = await studio.createFactEdit({
            entityId: 'purcari', fieldName: 'founded_year', value: '1827',
            sourceUrl: 'https://purcari.md/about', confidence: 'high',
            changedBy: 'editor-smoke', note: 'founded year from official site',
        }, { pool });
        wrapped.equal(fact.validation_status, 'candidate', 'new fact enters as candidate');
        wrapped.equal(fact.active, false, 'new fact is not active until approved');

        // Editor's candidate must NOT change the answer path.
        // The query tokens AND-match entity_id/field_name/raw_value, so a
        // 'Purcari founded_year 1827' question provably matches this fact.
        const ANSWER_QUERY = 'Purcari founded_year 1827';
        let before = await layeredRouter.searchCanonical(ANSWER_QUERY, { pool });
        wrapped.equal(before.find((r) => r.provenance?.fact_id === fact.id), undefined,
            'candidate fact is invisible to the canonical answer path');

        // ---------------- 2. review/approve --------------------------------
        const approved = await studio.reviewFact(fact.id, { action: 'approve', changedBy: 'editor-smoke', note: 'ok' }, { pool });
        wrapped.equal(approved.validation_status, 'approved', 'approved fact is approved');

        // ---------------- 3. answer path NOW uses the fact ----------------
        //   (this is the production answer layer — layeredRouter.searchCanonical —
        //    which is what the orchestrator feeds the model, not a studio view)
        const live = await studio.listFacts({ entityId: 'purcari', status: 'approved', active: true }, { pool });
        wrapped.equal(live.length, 1, 'exactly one live approved fact for purcari');
        const after = await layeredRouter.searchCanonical(ANSWER_QUERY, { pool });
        const used = after.find((r) => r.provenance?.fact_id === fact.id);
        wrapped.ok(used, 'approved fact is used by the answer path');
        wrapped.equal(used.provenance.validation_status, 'approved', 'answer provenance carries validation_status');
        wrapped.ok(used.provenance.verified_at, 'answer provenance carries verified_at');
        wrapped.equal(used.source, 'https://purcari.md/about', 'answer provenance carries source_url');

        // The Answer Audit renders claim provenance (buildClaimsFromEvidence →
        // publicClaim), so the same canonical item must surface in a claim.
        const { buildClaimsFromEvidence } = require('../src/knowledge/claimProvenance');
        const auditClaim = buildClaimsFromEvidence(after).find((c) => c.source?.url === 'https://purcari.md/about');
        wrapped.ok(auditClaim, 'approved fact is visible in the Answer Audit claim set');
        wrapped.equal(auditClaim.claim, 'founded_year: 1827', 'audit claim text carries the edited value');
        wrapped.ok(auditClaim.source.verified_at, 'audit claim carries the fact verified_at');

        // ---------------- 4. rollback: brand-new fact leaves canonical layer --
        const rolledBack = await studio.rollbackFact(fact.id, { changedBy: 'editor-smoke', note: 'mistake' }, { pool });
        wrapped.equal(rolledBack.validation_status, 'rejected', 'brand-new fact rolls back to rejected');
        const gone = await layeredRouter.searchCanonical(ANSWER_QUERY, { pool });
        wrapped.equal(gone.find((r) => r.provenance?.fact_id === fact.id), undefined,
            'after rollback the fact is not in the answer path');

        // ---------------- 5. edit of a LIVE fact: supersede + rollback -------
        const v1 = await studio.createFactEdit({
            entityId: 'purcari', fieldName: 'founded_year', value: '1826',
            sourceUrl: 'https://purcari.md', changedBy: 'editor-smoke',
        }, { pool });
        await studio.reviewFact(v1.id, { action: 'approve', changedBy: 'editor-smoke' }, { pool });
        const v2 = await studio.createFactEdit({
            entityId: 'purcari', fieldName: 'founded_year', value: '1827',
            sourceUrl: 'https://purcari.md/about', changedBy: 'editor-smoke',
        }, { pool });
        await studio.reviewFact(v2.id, { action: 'approve', changedBy: 'editor-smoke' }, { pool });

        const afterV2 = await studio.listFacts({ entityId: 'purcari', active: true }, { pool });
        const liveApproved = afterV2.filter((r) => r.validation_status === 'approved');
        wrapped.equal(liveApproved.length, 1, 'approving an edit supersedes the previous value');
        wrapped.equal(liveApproved[0].id, v2.id, 'the newest value is the live one');
        wrapped.equal(liveApproved[0].raw_value, '1827', 'live value is 1827');

        const restored = await studio.rollbackFact(v2.id, { changedBy: 'editor-smoke' }, { pool });
        wrapped.equal(restored.validation_status, 'stale', 'edit rollback deactivates the newer value');
        const afterRollbackV1 = await studio.listFacts({ entityId: 'purcari', active: true }, { pool });
        wrapped.equal(afterRollbackV1.filter((r) => r.validation_status === 'approved')[0].id, v1.id,
            'rollback restores the previous live value');

        // ---------------- 6. relation workflow through the answer path -------
        const rel = await studio.createRelationEdit({
            subjectId: 'purcari', predicate: 'produces', objectId: 'albastre-de-purcari',
            objectType: 'wine', sourceUrl: 'https://purcari.md/wines', changedBy: 'editor-smoke',
        }, { pool });
        wrapped.equal(rel.validation_status, 'candidate', 'new relation enters as candidate');
        const relBefore = await layeredRouter.searchRelations('Какие вина производит Purcari?', { pool });
        wrapped.equal(relBefore.find((r) => r.provenance?.relation_id === rel.id), undefined,
            'candidate relation is invisible to the answer path');

        await studio.reviewRelation(rel.id, { action: 'approve', changedBy: 'editor-smoke' }, { pool });
        const relAfter = await layeredRouter.searchRelations('Какие вина производит Purcari?', { pool });
        const relUsed = relAfter.find((r) => r.provenance?.relation_id === rel.id);
        wrapped.ok(relUsed, 'approved relation is used by the answer path');
        wrapped.equal(relUsed.provenance.relation_id, rel.id, 'answer provenance carries relation_id');
        wrapped.equal(relUsed.source_type, 'relation', 'answer provenance classifies it as a relation claim');

        await studio.rollbackRelation(rel.id, { changedBy: 'editor-smoke' }, { pool });
        const relGone = await layeredRouter.searchRelations('Какие вина производит Purcari?', { pool });
        wrapped.equal(relGone.find((r) => r.provenance?.relation_id === rel.id), undefined,
            'after rollback the relation is not in the answer path');

        // ---------------- 7. alias edit applies to canonical registry ---------
        const aliasEdit = await studio.createAliasEdit({
            entityId: 'purcari', alias: 'Пуркарь', language: 'ru', action: 'add',
            changedBy: 'editor-smoke',
        }, { pool });
        wrapped.equal(aliasEdit.status, 'pending', 'alias edit enters as pending');
        const registryBefore = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        wrapped.equal(registryBefore.find((e) => e.entityId === 'purcari').aliases.some((a) => a.alias === 'Пуркарь'), false,
            'pending alias edit does not touch the registry yet');

        await studio.reviewAliasEdit(aliasEdit.id, { action: 'approve', changedBy: 'editor-smoke' }, { pool });
        const registryAfter = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        const purcariAfter = registryAfter.find((e) => e.entityId === 'purcari');
        wrapped.ok(purcariAfter.aliases.some((a) => a.alias === 'Пуркарь' && a.lang === 'ru'),
            'approved alias write uses the registry strategy key (lang)');
        wrapped.ok(resolver.resolveEntity('Пуркарь'), 'resolver resolves the new alias after approve (cache invalidated)');

        await studio.rollbackAliasEdit(aliasEdit.id, { changedBy: 'editor-smoke' }, { pool });
        const registryReverted = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        wrapped.equal(registryReverted.find((e) => e.entityId === 'purcari').aliases.some((a) => a.alias === 'Пуркарь'), false,
            'rollback removes the applied alias from the registry');

        db.getPool = originalGetPool;
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });

        console.log('studioCanonicalWorkflow passed (' + assertionCount + ' assertions)');
        return { assertionCount };
    } catch (error) {
        db.getPool = originalGetPool;
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        throw error;
    }
}

module.exports = { run };
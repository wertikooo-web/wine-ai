'use strict';

// Knowledge Studio (Phase 5) — the editor-facing workflow store.
//
// Goal: an editor repairs production knowledge through the Studio UI/API —
// add/edit/reject/approve facts and relations, edit aliases (RU/RO/EN), review
// queues, duplicate merge, and rollback — without touching PostgreSQL, seed
// files, or manual scripts. No production knowledge change bypasses the
// review workflow: everything below enters as a pending/candidate row (or a
// pending alias edit) and only reaches the live canonical layer after an
// explicit approve.
//
// Source-of-truth layout (single owner per piece of mutable state):
//   - facts:     entity_facts (+ entity_facts_history ledger)  — read by
//                layeredRouter.searchCanonical (canonical layer);
//   - relations: entity_relations (+ entity_relations_history) — read by
//                layeredRouter.searchRelations / entityRelations.searchRelations;
//   - aliases:   knowledge/entity-aliases.json (the canonical registry file,
//                single source of truth for the resolver) — every approved
//                alias edit is applied to that file and the resolver's cache is
//                invalidated immediately; studio_alias_edits holds the durable
//                change/approval audit trail.
//
// Rollback contract: approving a fact/relation records a supersedes link in
// the history ledger (note `supersedes=<prevId>` / `superseded_by=<newId>`).
// rollback walks that link in reverse: the previous live row is reactivated,
// the current one deactivated. A brand-new fact/relation rolls back to
// "does not exist" (rejected/inactive).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../db');
const relations = require('../entityRelations');
const resolver = require('../entityResolver');
const { commitKnowledgeFiles } = require('../gitPersist');

const FACT_HISTORY_ACTIONS = ['created', 'edit_requested', 'published', 'superseded', 'rejected', 'restored', 'merged'];
const ALIAS_EDIT_ACTIONS = ['add', 'remove', 'rename'];
const ALIAS_EDIT_STATUSES = ['pending', 'approved', 'rejected', 'superseded'];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function genId(prefix) {
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------- facts ----

async function listFacts({ entityId = null, fieldName = null, status = null, active = null, limit = 200 } = {}, { pool = db.getPool() } = {}) {
    if (!pool) return [];
    const clauses = [];
    const params = [];
    if (entityId) { params.push(String(entityId)); clauses.push(`entity_id = $${params.length}`); }
    if (fieldName) { params.push(String(fieldName)); clauses.push(`field_name = $${params.length}`); }
    if (status) { params.push(String(status)); clauses.push(`validation_status = $${params.length}`); }
    if (active != null) { params.push(Boolean(active)); clauses.push(`active = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
        SELECT * FROM entity_facts ${where}
        ORDER BY field_name, updated_at DESC
        LIMIT $${params.length + 1}
    `, [...params, limit]);
    return rows;
}

async function getFact(id, { pool = db.getPool() } = {}) {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT * FROM entity_facts WHERE id = $1', [id]);
    return rows[0] || null;
}

async function _writeFactHistory(pool, { factId, action, prevStatus = null, newStatus = null, changedBy = 'editor', note = null }) {
    if (!pool) return;
    await pool.query(`
        INSERT INTO entity_facts_history
            (id, fact_id, action, prev_status, new_status, changed_by, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [genId('fh'), factId, action, prevStatus, newStatus, changedBy, note]);
}

// Records an editor's proposed fact change as a candidate row. The current
// live value (if any) stays active until this candidate is approved.
async function createFactEdit({
    entityId,
    entityType = null,
    fieldName,
    value,
    sourceUrl = null,
    sourceType = 'studio_edit',
    confidence = 'high',
    evidence = null,
    changedBy = 'editor',
    note = null,
} = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!entityId || !fieldName || value == null || String(value).trim() === '') {
        throw Object.assign(new Error('FACT_REQUIRED'), { code: 'FACT_REQUIRED' });
    }
    if (!['high', 'medium', 'low'].includes(confidence)) {
        throw Object.assign(new Error('INVALID_CONFIDENCE'), { code: 'INVALID_CONFIDENCE' });
    }
    const entity = resolver.findByEntityId(entityId);
    const resolvedType = entityType || entity?.entityType || 'unknown';
    const id = genId('fact');
    const now = new Date().toISOString();
    const row = {
        id,
        entity_id: entityId,
        entity_type: resolvedType,
        field_name: fieldName,
        normalized_value: normalize(value),
        raw_value: String(value).trim(),
        confidence,
        validation_status: 'candidate',
        active: false,
        source_url: sourceUrl,
        source_type: sourceType,
        source_domain: 'studio',
        evidence: evidence,
        extraction_method: 'studio',
        extractor_version: 'studio-v1',
        conflict_state: 'none',
        fetched_at: now,
        verified_at: null,
        expires_at: null,
        created_at: now,
        updated_at: now,
    };
    await pool.query(`
        INSERT INTO entity_facts
            (id, entity_id, entity_type, field_name, normalized_value, raw_value,
             confidence, validation_status, active, source_url, source_type,
             source_domain, evidence, extraction_method, extractor_version,
             conflict_state, fetched_at, verified_at, expires_at, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    `, [
        row.id, row.entity_id, row.entity_type, row.field_name, row.normalized_value, row.raw_value,
        row.confidence, row.validation_status, row.active, row.source_url, row.source_type,
        row.source_domain, row.evidence, row.extraction_method, row.extractor_version,
        row.conflict_state, row.fetched_at, row.verified_at, row.expires_at, row.created_at, row.updated_at,
    ]);
    await _writeFactHistory(pool, {
        factId: row.id, action: 'edit_requested', newStatus: 'candidate', changedBy, note,
    });
    return row;
}

// Approves or rejects a candidate fact. Approve activates the fact in the
// canonical layer and supersedes the previous live value for the same
// entity+field (old row → stale/inactive) so the answer path never holds two
// active approved values for one field.
async function reviewFact(id, { action, changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!['approve', 'reject'].includes(action)) {
        throw Object.assign(new Error('INVALID_REVIEW_ACTION'), { code: 'INVALID_REVIEW_ACTION' });
    }
    const fact = await getFact(id, { pool });
    if (!fact) throw Object.assign(new Error('FACT_NOT_FOUND'), { code: 'FACT_NOT_FOUND' });
    if (fact.validation_status === 'approved' || fact.validation_status === 'rejected') {
        throw Object.assign(new Error('FACT_ALREADY_REVIEWED'), { code: 'FACT_ALREADY_REVIEWED' });
    }

    if (action === 'reject') {
        await pool.query(
            `UPDATE entity_facts SET validation_status = 'rejected', active = FALSE, updated_at = NOW() WHERE id = $1`,
            [id]
        );
        await _writeFactHistory(pool, {
            factId: id, action: 'rejected', prevStatus: fact.validation_status, newStatus: 'rejected', changedBy, note,
        });
        return { ...fact, validation_status: 'rejected', active: false };
    }

    // approve
    const superseded = await pool.query(`
        SELECT * FROM entity_facts
        WHERE id <> $1 AND entity_id = $2 AND field_name = $3
          AND active = TRUE AND validation_status IN ('approved','validated')
        ORDER BY updated_at DESC
    `, [id, fact.entity_id, fact.field_name]);
    await pool.query(`
        UPDATE entity_facts
        SET validation_status = 'approved', active = TRUE, verified_at = NOW(), updated_at = NOW()
        WHERE id = $1
    `, [id]);
    for (const old of superseded.rows) {
        await pool.query(
            `UPDATE entity_facts SET validation_status = 'stale', active = FALSE, updated_at = NOW() WHERE id = $1`,
            [old.id]
        );
        await _writeFactHistory(pool, {
            factId: old.id, action: 'superseded', prevStatus: old.validation_status, newStatus: 'stale',
            changedBy, note: `superseded_by=${id}`,
        });
    }
    const supersedeNote = superseded.rows.length
        ? `supersedes=${superseded.rows.map((r) => r.id).join(',')}`
        : null;
    await _writeFactHistory(pool, {
        factId: id, action: 'published', prevStatus: fact.validation_status, newStatus: 'approved',
        changedBy, note: supersedeNote,
    });
    return { ...fact, validation_status: 'approved', active: true };
}

// Restores the previous live value for a fact that was superseded by `id`'s
// approval. Brand-new facts (no supersedes link) roll back to rejected —
// i.e. they stop existing in the canonical layer.
async function rollbackFact(id, { changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    const fact = await getFact(id, { pool });
    if (!fact) throw Object.assign(new Error('FACT_NOT_FOUND'), { code: 'FACT_NOT_FOUND' });

    const history = await pool.query(`
        SELECT * FROM entity_facts_history WHERE fact_id = $1 AND action = 'published' ORDER BY changed_at DESC
    `, [id]);
    const published = history.rows.find((r) => r.note && /supersedes=/.test(r.note || ''));
    const prevId = published ? (published.note.match(/supersedes=([\w,-]+)/) || [])[1] : null;

    if (prevId) {
        const prevIds = prevId.split(',');
        for (const prev of prevIds) {
            await pool.query(
                `UPDATE entity_facts SET validation_status = 'approved', active = TRUE, verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
                [prev]
            );
            await _writeFactHistory(pool, {
                factId: prev, action: 'restored', newStatus: 'approved', changedBy,
                note: `rollback_of=${id}`,
            });
        }
        await pool.query(
            `UPDATE entity_facts SET validation_status = 'stale', active = FALSE, updated_at = NOW() WHERE id = $1`,
            [id]
        );
        await _writeFactHistory(pool, {
            factId: id, action: 'rejected', prevStatus: 'approved', newStatus: 'stale', changedBy,
            note: note || `rolled_back; restored ${prevId}`,
        });
        return { ...fact, validation_status: 'stale', active: false };
    }

    // brand-new fact: remove from canonical layer
    await pool.query(
        `UPDATE entity_facts SET validation_status = 'rejected', active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id]
    );
    await _writeFactHistory(pool, {
        factId: id, action: 'rejected', prevStatus: fact.validation_status, newStatus: 'rejected', changedBy,
        note: note || 'rolled_back (fact did not exist before)',
    });
    return { ...fact, validation_status: 'rejected', active: false };
}

// ------------------------------------------------------------ relations ----

async function listRelations({ entityId = null, status = null, active = null, limit = 200 } = {}, { pool = db.getPool() } = {}) {
    if (!pool) return [];
    const clauses = [];
    const params = [];
    if (entityId) { params.push(String(entityId)); clauses.push(`(subject_id = $${params.length} OR object_id = $${params.length})`); }
    if (status) { params.push(String(status)); clauses.push(`validation_status = $${params.length}`); }
    if (active != null) { params.push(Boolean(active)); clauses.push(`active = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
        SELECT * FROM entity_relations ${where}
        ORDER BY subject_id, predicate, updated_at DESC
        LIMIT $${params.length + 1}
    `, [...params, limit]);
    return rows;
}

// Proposes a relation change. A brand-new relation uses the deterministic
// identity id (idempotent upsert); an edit of an existing live relation gets a
// suffixed candidate id so the old edge stays live until the edit is approved.
async function createRelationEdit({
    subjectId,
    subjectType = 'winery',
    predicate,
    objectId = null,
    objectType = null,
    objectValue = null,
    confidence = 'high',
    sourceUrl = null,
    sourceType = 'studio_edit',
    evidence = null,
    changedBy = 'editor',
    note = null,
} = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!subjectId || !predicate) {
        throw Object.assign(new Error('SUBJECT_AND_PREDICATE_REQUIRED'), { code: 'SUBJECT_AND_PREDICATE_REQUIRED' });
    }
    if (objectId && !objectType) {
        throw Object.assign(new Error('OBJECT_ID_REQUIRES_OBJECT_TYPE'), { code: 'OBJECT_ID_REQUIRES_OBJECT_TYPE' });
    }
    if (objectValue == null && !objectId) {
        throw Object.assign(new Error('OBJECT_REQUIRED'), { code: 'OBJECT_REQUIRED' });
    }
    if (!['high', 'medium', 'low'].includes(confidence)) {
        throw Object.assign(new Error('INVALID_CONFIDENCE'), { code: 'INVALID_CONFIDENCE' });
    }
    if (!relations.isRoadmapPredicate(predicate)) {
        throw Object.assign(new Error('PREDICATE_NOT_IN_VOCABULARY'), { code: 'PREDICATE_NOT_IN_VOCABULARY' });
    }

    const objectKey = relations.objectKeyFor({ objectId, objectValue, objectType });
    const baseId = relations.relationId(subjectId, predicate, objectKey);
    const live = await listRelations({ entityId: null, status: null, active: true }, { pool });
    const existingLive = live.find((r) => r.id === baseId && ['approved', 'validated'].includes(r.validation_status));

    if (!existingLive) {
        // New relation — deterministic id, candidate, inactive until approved.
        return relations.createRelation({
            subjectId, subjectType, predicate, objectId, objectType, objectValue,
            confidence, status: 'candidate', active: false,
            sourceUrl, sourceType, sourceDomain: 'studio', evidence,
            changedBy,
        }, { pool });
    }

    // Edit of a live relation — distinct candidate id + supersede link.
    const id = `${baseId}_e${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const now = new Date().toISOString();
    const row = {
        id,
        subject_id: subjectId,
        subject_type: subjectType,
        predicate,
        object_id: objectId,
        object_type: objectType,
        object_value: objectValue,
        confidence,
        validation_status: 'candidate',
        active: false,
        source_url: sourceUrl,
        source_type: sourceType,
        source_domain: 'studio',
        evidence,
        verified_at: null,
        expires_at: null,
        created_at: now,
        updated_at: now,
    };
    await pool.query(`
        INSERT INTO entity_relations
            (id, subject_id, subject_type, predicate, object_id, object_type,
             object_value, confidence, validation_status, active, source_url,
             source_type, source_domain, evidence, verified_at, expires_at,
             created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    `, [
        row.id, row.subject_id, row.subject_type, row.predicate, row.object_id, row.object_type,
        row.object_value, row.confidence, row.validation_status, row.active, row.source_url,
        row.source_type, row.source_domain, row.evidence, row.verified_at, row.expires_at,
        row.created_at, row.updated_at,
    ]);
    await _writeRelationHistory(pool, {
        relationId: row.id, action: 'edit_requested', newStatus: 'candidate', changedBy,
        note: `supersedes=${existingLive.id}${note ? `; ${note}` : ''}`,
    });
    return row;
}

async function _writeRelationHistory(pool, { relationId, action, prevStatus = null, newStatus = null, changedBy = 'editor', note = null }) {
    if (!pool) return;
    await pool.query(`
        INSERT INTO entity_relations_history
            (id, relation_id, action, prev_status, new_status, changed_by, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [genId('relh'), relationId, action, prevStatus, newStatus, changedBy, note]);
}

async function reviewRelation(id, { action, changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!['approve', 'reject'].includes(action)) {
        throw Object.assign(new Error('INVALID_REVIEW_ACTION'), { code: 'INVALID_REVIEW_ACTION' });
    }
    const existing = await relations.getRelation(id, { pool });
    if (!existing) throw Object.assign(new Error('RELATION_NOT_FOUND'), { code: 'RELATION_NOT_FOUND' });

    if (action === 'reject') {
        return relations.rejectRelation(id, { changedBy, note }, { pool });
    }

    const supersedeTarget = await _supersededRelationFor(id, pool);
    await relations.publishRelation(id, { status: 'approved', changedBy }, { pool });
    if (supersedeTarget) {
        await pool.query(
            `UPDATE entity_relations SET validation_status = 'stale', active = FALSE, updated_at = NOW() WHERE id = $1`,
            [supersedeTarget]
        );
        await _writeRelationHistory(pool, {
            relationId: supersedeTarget, action: 'superseded', prevStatus: 'approved', newStatus: 'stale',
            changedBy, note: `superseded_by=${id}`,
        });
    }
    return { ...existing, validation_status: 'approved', active: true };
}

async function _supersededRelationFor(id, pool) {
    const { rows } = await pool.query(
        `SELECT * FROM entity_relations_history WHERE relation_id = $1 AND action = 'edit_requested' ORDER BY changed_at DESC`,
        [id]
    );
    const row = rows.find((r) => r.note && /supersedes=/.test(r.note || ''));
    if (!row) return null;
    const match = (row.note.match(/supersedes=([\w-]+)/) || [])[1];
    return match || null;
}

async function rollbackRelation(id, { changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    const existing = await relations.getRelation(id, { pool });
    if (!existing) throw Object.assign(new Error('RELATION_NOT_FOUND'), { code: 'RELATION_NOT_FOUND' });

    const prevId = await _supersededRelationFor(id, pool);
    if (prevId) {
        await pool.query(
            `UPDATE entity_relations SET validation_status = 'approved', active = TRUE, verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [prevId]
        );
        await _writeRelationHistory(pool, {
            relationId: prevId, action: 'restored', newStatus: 'approved', changedBy,
            note: `rollback_of=${id}`,
        });
        await pool.query(
            `UPDATE entity_relations SET validation_status = 'stale', active = FALSE, updated_at = NOW() WHERE id = $1`,
            [id]
        );
        await _writeRelationHistory(pool, {
            relationId: id, action: 'rejected', prevStatus: 'approved', newStatus: 'stale', changedBy,
            note: note || `rolled_back; restored ${prevId}`,
        });
        return { ...existing, validation_status: 'stale', active: false };
    }

    // brand-new relation: remove from canonical layer
    await pool.query(
        `UPDATE entity_relations SET validation_status = 'rejected', active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id]
    );
    await _writeRelationHistory(pool, {
        relationId: id, action: 'rejected', prevStatus: existing.validation_status, newStatus: 'rejected', changedBy,
        note: note || 'rolled_back (relation did not exist before)',
    });
    return { ...existing, validation_status: 'rejected', active: false };
}

// --------------------------------------------------------------- aliases ---

function _registryFilePath() {
    return resolver.aliasesFilePath();
}

function _loadRegistry() {
    return JSON.parse(fs.readFileSync(_registryFilePath(), 'utf8'));
}

function _saveRegistry(data) {
    fs.writeFileSync(_registryFilePath(), JSON.stringify(data, null, 2), 'utf8');
}

async function _commitRegistry(message) {
    try {
        await commitKnowledgeFiles(REPO_ROOT, [_registryFilePath()], message);
    } catch (error) {
        console.error('[studio] registry git commit failed (best-effort):', error.message);
    }
}

function _findRegistryEntity(data, entityId) {
    return data.find((e) => e.entityId === entityId) || null;
}

// Applies an alias edit to an in-memory registry copy. Pure function — the
// caller decides when to persist. Returns the number of aliases changed.
function _applyAliasChangeToRegistry(data, edit) {
    const entity = _findRegistryEntity(data, edit.entity_id);
    if (!entity) return 0;
    if (!Array.isArray(entity.aliases)) entity.aliases = [];
    const norm = (s) => String(s || '').trim().toLocaleLowerCase();
    const existingIndex = (alias, lang) => entity.aliases.findIndex(
        (a) => norm(a.alias) === norm(alias) && String(a.language || a.lang || '').toLocaleLowerCase() === String(lang || '').toLocaleLowerCase()
    );

    if (edit.action === 'remove') {
        const before = entity.aliases.length;
        entity.aliases = entity.aliases.filter(
            (a) => !(norm(a.alias) === norm(edit.alias) && String(a.language || a.lang || '') === String(edit.language || ''))
        );
        return before - entity.aliases.length;
    }

    if (edit.action === 'rename') {
        const idx = existingIndex(edit.prev_alias, edit.language);
        if (idx >= 0) {
            entity.aliases[idx].alias = edit.alias.trim();
            if (edit.language) entity.aliases[idx].lang = edit.language;
            return 1;
        }
        // prev_alias missing — treat as add
    }

    // add
    const idx = existingIndex(edit.alias, edit.language);
    if (idx >= 0) {
        entity.aliases[idx].alias = edit.alias.trim();
        if (edit.language) entity.aliases[idx].lang = edit.language;
        return 1;
    }
    entity.aliases.push({ alias: edit.alias.trim(), ...(edit.language ? { lang: edit.language } : {}) });
    return 1;
}

async function listAliasEdits({ entityId = null, status = null, limit = 200 } = {}, { pool = db.getPool() } = {}) {
    if (!pool) return [];
    const clauses = [];
    const params = [];
    if (entityId) { params.push(String(entityId)); clauses.push(`entity_id = $${params.length}`); }
    if (status) { params.push(String(status)); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
        SELECT * FROM studio_alias_edits ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1}
    `, [...params, limit]);
    return rows;
}

async function getAliasEdit(id, { pool = db.getPool() } = {}) {
    if (!pool) return null;
    const { rows } = await pool.query('SELECT * FROM studio_alias_edits WHERE id = $1', [id]);
    return rows[0] || null;
}

async function createAliasEdit({
    entityId,
    alias,
    language = null,
    action = 'add',
    prevAlias = null,
    changedBy = 'editor',
    note = null,
} = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!entityId || !alias || String(alias).trim() === '') {
        throw Object.assign(new Error('ALIAS_REQUIRED'), { code: 'ALIAS_REQUIRED' });
    }
    if (!ALIAS_EDIT_ACTIONS.includes(action)) {
        throw Object.assign(new Error('INVALID_ALIAS_ACTION'), { code: 'INVALID_ALIAS_ACTION' });
    }
    if (action === 'rename' && !prevAlias) {
        throw Object.assign(new Error('RENAME_REQUIRES_PREV_ALIAS'), { code: 'RENAME_REQUIRES_PREV_ALIAS' });
    }
    const registry = _loadRegistry();
    if (!_findRegistryEntity(registry, entityId)) {
        throw Object.assign(new Error('ENTITY_NOT_IN_REGISTRY'), { code: 'ENTITY_NOT_IN_REGISTRY' });
    }
    const id = genId('alias');
    await pool.query(`
        INSERT INTO studio_alias_edits
            (id, entity_id, alias, language, action, prev_alias, status, changed_by, note, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,NOW())
    `, [id, entityId, alias.trim(), language || null, action, prevAlias || null, changedBy, note || null]);
    const { rows } = await pool.query('SELECT * FROM studio_alias_edits WHERE id = $1', [id]);
    return rows[0];
}

async function reviewAliasEdit(id, { action, changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!['approve', 'reject'].includes(action)) {
        throw Object.assign(new Error('INVALID_REVIEW_ACTION'), { code: 'INVALID_REVIEW_ACTION' });
    }
    const edit = await getAliasEdit(id, { pool });
    if (!edit) throw Object.assign(new Error('ALIAS_EDIT_NOT_FOUND'), { code: 'ALIAS_EDIT_NOT_FOUND' });
    if (edit.status !== 'pending') {
        throw Object.assign(new Error('ALIAS_EDIT_ALREADY_REVIEWED'), { code: 'ALIAS_EDIT_ALREADY_REVIEWED' });
    }

    if (action === 'reject') {
        await pool.query(
            `UPDATE studio_alias_edits SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), note = COALESCE(note, '') || COALESCE('; ' || $3, '') WHERE id = $2`,
            [changedBy, id, note || null]
        );
        return { ...edit, status: 'rejected', reviewed_by: changedBy, reviewed_at: new Date().toISOString() };
    }

    const registry = _loadRegistry();
    const changed = _applyAliasChangeToRegistry(registry, edit);
    if (changed > 0) {
        _saveRegistry(registry);
        resolver.invalidateAliasCache();
        await _commitRegistry(`Knowledge Studio: approve alias ${edit.action} for ${edit.entity_id} (${edit.alias})`);
    }
    await pool.query(
        `UPDATE studio_alias_edits SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), note = COALESCE(note, '') || COALESCE('; ' || $3, '') WHERE id = $2`,
        [changedBy, id, note || null]
    );
    return { ...edit, status: 'approved', reviewed_by: changedBy, reviewed_at: new Date().toISOString() };
}

async function rollbackAliasEdit(id, { changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    const edit = await getAliasEdit(id, { pool });
    if (!edit) throw Object.assign(new Error('ALIAS_EDIT_NOT_FOUND'), { code: 'ALIAS_EDIT_NOT_FOUND' });
    if (edit.status !== 'approved') {
        throw Object.assign(new Error('ALIAS_EDIT_NOT_APPROVED'), { code: 'ALIAS_EDIT_NOT_APPROVED' });
    }

    // Apply the inverse change to restore the pre-edit registry state.
    const inverse = {
        entity_id: edit.entity_id,
        action: edit.action === 'add' ? 'remove' : edit.action === 'remove' ? 'add' : 'rename',
        alias: edit.action === 'rename' ? edit.prev_alias : edit.alias,
        language: edit.language,
        prev_alias: edit.action === 'rename' ? edit.alias : edit.prev_alias,
    };
    const registry = _loadRegistry();
    const changed = _applyAliasChangeToRegistry(registry, inverse);
    if (changed > 0) {
        _saveRegistry(registry);
        resolver.invalidateAliasCache();
        await _commitRegistry(`Knowledge Studio: rollback alias edit ${edit.id} for ${edit.entity_id}`);
    }
    await pool.query(
        `UPDATE studio_alias_edits SET status = 'superseded', reviewed_by = $1, reviewed_at = NOW(), note = COALESCE(note, '') || COALESCE('; ' || $2, '') WHERE id = $3`,
        [changedBy, note || 'rolled_back', id]
    );
    return { ...edit, status: 'superseded', reviewed_by: changedBy, reviewed_at: new Date().toISOString() };
}

// ------------------------------------------------------- review queues -----

async function getReviewQueues({ pool = db.getPool() } = {}) {
    if (!pool) return { enabled: false, queues: {} };

    const pendingFacts = await listFacts({ status: null }, { pool });
    const pendingFactRows = pendingFacts.filter((r) => ['candidate', 'needs_review', 'discovered'].includes(r.validation_status));
    const staleFactRows = pendingFacts.filter((r) => r.validation_status === 'stale');
    const conflictRows = pendingFacts.filter((r) => r.conflict_state === 'detected' && r.active === true);

    const allRelations = await listRelations({}, { pool });
    const pendingRelationRows = allRelations.filter((r) => ['candidate', 'needs_review'].includes(r.validation_status));
    const unknownPredicateRows = allRelations.filter((r) => !relations.isRoadmapPredicate(r.predicate));

    const pendingAliasRows = await listAliasEdits({ status: 'pending' }, { pool });

    return {
        enabled: true,
        queues: {
            pending_fact_edits: pendingFactRows,
            stale_facts: staleFactRows,
            conflicting_facts: conflictRows,
            pending_relation_edits: pendingRelationRows,
            unknown_predicate_relations: unknownPredicateRows,
            pending_alias_edits: pendingAliasRows,
            possible_duplicates: findDuplicateCandidates(),
        },
    };
}

// ------------------------------------------------------------ duplicates ----

function _normalizeNameSet(entity) {
    const names = new Set();
    const add = (s) => {
        const n = normalize(s);
        if (n) names.add(n);
    };
    add(entity.canonicalName);
    for (const a of entity.aliases || []) add(a.alias);
    return names;
}

// Registry-level duplicate candidates: entities whose canonical name or
// aliases overlap. Pure registry scan — cheap for the current 112 entities.
function findDuplicateCandidates({ aliasesFile = null } = {}) {
    const filePath = aliasesFile || _registryFilePath();
    let data;
    try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error('[studio] duplicate scan failed:', error.message);
        return [];
    }
    const groups = [];
    for (let i = 0; i < data.length; i++) {
        const a = data[i];
        if (a.mergedInto) continue;
        const setA = _normalizeNameSet(a);
        for (let j = i + 1; j < data.length; j++) {
            const b = data[j];
            if (b.mergedInto) continue;
            if (a.entityId === b.entityId) continue;
            const setB = _normalizeNameSet(b);
            const overlap = [...setA].filter((n) => setB.has(n));
            if (overlap.length) {
                groups.push({ entityIdA: a.entityId, entityIdB: b.entityId, overlap });
            }
        }
    }
    return groups;
}

// Merges entity `mergeId` into `keepId`: its facts, relations, and aliases
// move to the keeper; the merged registry entry is marked mergedInto so past
// mentions still resolve. History records every move.
async function mergeEntities({ keepId, mergeId, changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) throw Object.assign(new Error('DATABASE_REQUIRED'), { code: 'DATABASE_REQUIRED' });
    if (!keepId || !mergeId || keepId === mergeId) {
        throw Object.assign(new Error('MERGE_REQUIRES_TWO_DISTINCT_ENTITIES'), { code: 'MERGE_REQUIRES_TWO_DISTINCT_ENTITIES' });
    }
    const registry = _loadRegistry();
    const keepEntity = _findRegistryEntity(registry, keepId);
    const mergeEntity = _findRegistryEntity(registry, mergeId);
    if (!keepEntity || !mergeEntity) {
        throw Object.assign(new Error('MERGE_ENTITY_NOT_IN_REGISTRY'), { code: 'MERGE_ENTITY_NOT_IN_REGISTRY' });
    }

    // facts: move mergeId's facts to keepId; if keepId already has a live
    // approved value for the same field, the moved one is superseded (stale).
    const mergeFacts = await listFacts({ entityId: mergeId }, { pool });
    const keepLive = new Map();
    for (const f of (await listFacts({ entityId: keepId }, { pool }))) {
        if (f.active && ['approved', 'validated'].includes(f.validation_status)) keepLive.set(f.field_name, f);
    }
    for (const fact of mergeFacts) {
        if (keepLive.has(fact.field_name) && fact.active && ['approved', 'validated'].includes(fact.validation_status)) {
            await pool.query(
                `UPDATE entity_facts SET validation_status = 'stale', active = FALSE, updated_at = NOW() WHERE id = $1`,
                [fact.id]
            );
        } else {
            await pool.query(`UPDATE entity_facts SET entity_id = $1, updated_at = NOW() WHERE id = $2`, [keepId, fact.id]);
        }
        await _writeFactHistory(pool, {
            factId: fact.id, action: 'merged', prevStatus: fact.validation_status, changedBy,
            note: `entity_merge ${mergeId} -> ${keepId}${note ? `; ${note}` : ''}`,
        });
    }

    // relations: retarget both subject and object sides to the keeper.
    await pool.query(`UPDATE entity_relations SET subject_id = $1, updated_at = NOW() WHERE subject_id = $2`, [keepId, mergeId]);
    await pool.query(`UPDATE entity_relations SET object_id = $1, updated_at = NOW() WHERE object_id = $2 AND subject_id <> $1`, [keepId, mergeId]);
    const affectedRelations = await listRelations({ entityId: keepId }, { pool });
    for (const rel of affectedRelations) {
        await _writeRelationHistory(pool, {
            relationId: rel.id, action: 'updated', changedBy,
            note: `entity_merge ${mergeId} -> ${keepId}${note ? `; ${note}` : ''}`,
        });
    }

    // aliases: merge the alias lists in the registry, mark merged entity.
    const keepAliases = new Map((keepEntity.aliases || []).map((a) => [`${normalize(a.alias)}:${String(a.language || '').toLocaleLowerCase()}`, a]));
    for (const a of mergeEntity.aliases || []) {
        const key = `${normalize(a.alias)}:${String(a.language || '').toLocaleLowerCase()}`;
        if (!keepAliases.has(key)) {
            keepEntity.aliases.push(a);
            keepAliases.set(key, a);
        }
    }
    mergeEntity.mergedInto = keepId;
    _saveRegistry(registry);
    resolver.invalidateAliasCache();
    await _commitRegistry(`Knowledge Studio: merge entity ${mergeId} into ${keepId}`);

    return { keepId, mergeId, facts_moved: mergeFacts.length, registry_merged: true };
}

// ------------------------------------------------------------ entity card ---

async function getEntityHistory(entityId, { pool = db.getPool() } = {}) {
    if (!pool) return [];
    const facts = await listFacts({ entityId }, { pool });
    const factIds = facts.map((f) => f.id);
    const relationsRows = await listRelations({ entityId }, { pool });
    const relationIds = relationsRows.map((r) => r.id);
    const aliasEdits = await listAliasEdits({ entityId }, { pool });

    const history = [];
    for (const id of factIds) {
        const { rows } = await pool.query(
            'SELECT * FROM entity_facts_history WHERE fact_id = $1 ORDER BY changed_at DESC', [id]
        );
        history.push(...rows.map((r) => ({ ...r, kind: 'fact', fact_id: r.fact_id, relation_id: null, alias_edit_id: null })));
    }
    for (const id of relationIds) {
        const { rows } = await pool.query(
            'SELECT * FROM entity_relations_history WHERE relation_id = $1 ORDER BY changed_at DESC', [id]
        );
        history.push(...rows.map((r) => ({ ...r, kind: 'relation', fact_id: null, relation_id: r.relation_id, alias_edit_id: null })));
    }
    history.push(...aliasEdits.map((r) => ({
        id: r.id, kind: 'alias', action: `alias_${r.action}`, prev_status: 'pending', new_status: r.status,
        changed_by: r.changed_by, note: r.note, changed_at: r.reviewed_at || r.created_at,
        fact_id: null, relation_id: null, alias_edit_id: r.id,
    })));

    return history.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
}

async function getEntityCard(entityId, { pool = db.getPool() } = {}) {
    const registryEntity = resolver.findByEntityId(entityId);
    const mergedInto = _findMergedTarget(entityId);
    const facts = await listFacts({ entityId }, { pool });
    const relationRows = await listRelations({ entityId }, { pool });
    const aliasEdits = await listAliasEdits({ entityId }, { pool });

    const aliasesByLang = {};
    for (const a of (registryEntity?.aliases || [])) {
        const lang = a.language || a.lang || 'other';
        if (!aliasesByLang[lang]) aliasesByLang[lang] = [];
        aliasesByLang[lang].push(a.alias);
    }
    for (const edit of aliasEdits) {
        if (edit.status !== 'approved') continue;
        const lang = edit.language || 'other';
        if (edit.action === 'remove') {
            aliasesByLang[lang] = (aliasesByLang[lang] || []).filter((s) => normalize(s) !== normalize(edit.alias));
        } else {
            if (!aliasesByLang[lang]) aliasesByLang[lang] = [];
            if (!aliasesByLang[lang].some((s) => normalize(s) === normalize(edit.alias))) aliasesByLang[lang].push(edit.alias);
        }
    }

    return {
        entityId,
        canonicalName: registryEntity?.canonicalName || entityId,
        entityType: registryEntity?.entityType || null,
        description: registryEntity?.description || null,
        mergedInto,
        aliases: aliasesByLang,
        facts,
        relations: relationRows,
        aliasEdits,
        history: await getEntityHistory(entityId, { pool }),
        registryPresent: Boolean(registryEntity),
    };
}

function _findMergedTarget(entityId) {
    try {
        const data = _loadRegistry();
        const entity = _findRegistryEntity(data, entityId);
        return entity?.mergedInto || null;
    } catch {
        return null;
    }
}

async function searchEntities(query, { pool = db.getPool() } = {}) {
    const q = normalize(query);
    const registry = _loadRegistry();
    const enriched = [];
    for (const entity of registry) {
        if (entity.mergedInto) continue;
        const names = [entity.canonicalName, ...(entity.aliases || []).map((a) => a.alias)];
        const matched = !q || names.some((n) => normalize(n).includes(q));
        if (!matched) continue;
        let factCount = 0;
        let liveFactCount = 0;
        if (pool) {
            const rows = await listFacts({ entityId: entity.entityId }, { pool });
            factCount = rows.length;
            liveFactCount = rows.filter((r) => r.active && ['approved', 'validated'].includes(r.validation_status)).length;
        }
        enriched.push({
            entityId: entity.entityId,
            canonicalName: entity.canonicalName,
            entityType: entity.entityType,
            factCount,
            liveFactCount,
        });
    }
    return enriched;
}

module.exports = {
    createFactEdit,
    reviewFact,
    rollbackFact,
    listFacts,
    getFact,
    createRelationEdit,
    reviewRelation,
    rollbackRelation,
    listRelations,
    createAliasEdit,
    reviewAliasEdit,
    rollbackAliasEdit,
    listAliasEdits,
    getAliasEdit,
    getReviewQueues,
    findDuplicateCandidates,
    mergeEntities,
    getEntityCard,
    getEntityHistory,
    searchEntities,
    _applyAliasChangeToRegistry,
    _findRegistryEntity,
    FACT_HISTORY_ACTIONS,
    ALIAS_EDIT_ACTIONS,
    ALIAS_EDIT_STATUSES,
};

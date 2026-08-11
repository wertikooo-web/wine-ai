'use strict';

// Entity Relations — Phase 4 v1 knowledge-graph store.
//
// Structured edges between the core entity types (winery, wine, grape_variety,
// wine_region) following the ONTOLOGY in
// docs/architecture/WINE_KNOWLEDGE_STRATEGY_AND_ROADMAP.md §7. The controlled
// relation vocabulary below IS the roadmap vocabulary 1:1 -- there is no
// parallel vocabulary. Only the roadmap-listed predicates may be ingested; a
// predicate outside the vocabulary is stored but forced to needs_review and
// never published (roadmap §7: "Unknown relation types should enter
// needs_review rather than production answers").
//
// Every production relation carries full provenance: source_url/type/domain,
// evidence, confidence, validation_status, active, verified_at/expires_at,
// created_at/updated_at, plus an append-only history ledger.

const db = require('./db');
const { findMentionedEntities, findByEntityId } = require('./entityResolver');

// Full approved vocabulary from the roadmap §7 (entity types for v1).
const ENTITY_TYPES = Object.freeze([
    'winery',
    'wine',
    'grape_variety',
    'wine_region',
]);

// Full approved relation vocabulary from the roadmap §7. The v1 controlled
// subset (RELATION_PREDICATES below) is what Phase 4 publishes; every other
// roadmap predicate is storable but never publishable yet.
const ROADMAP_PREDICATES = Object.freeze([
    'produces',
    'made_from',
    'blend_percentage',
    'located_in',
    'part_of_region',
    'uses_grape',
    'offers_tour',
    'offers_tasting',
    'has_restaurant',
    'has_hotel',
    'has_museum',
    'founded_by',
    'owned_by',
    'has_aroma',
    'has_flavor',
    'food_pairing',
    'won_award',
    'available_as_product',
]);

// v1 publishable subset (user-approved scope for Phase 4).
const RELATION_PREDICATES = Object.freeze([
    'produces',
    'made_from',
    'located_in',
    'part_of_region',
    'offers_tour',
    'offers_tasting',
]);

const VALIDATION_STATUSES = Object.freeze([
    'needs_review',
    'candidate',
    'validated',
    'approved',
    'rejected',
    'stale',
]);

// Multi-language predicate hints for relation-aware query resolution. These
// only steer which roadmap predicate a natural-language query is asking about;
// they never widen or rename the controlled vocabulary.
const PREDICATE_HINTS = Object.freeze([
    { predicate: 'produces', re: /(производит|производств|выпуска|делают|делает|производят|produces|produce|makes|make|produc|fabric)/iu },
    { predicate: 'made_from', re: /(из винограда|из каберне|из мерло|из фетяск|из сорта|made from|made of|blend of|на основе|дин каберне|дин мерло)/iu },
    { predicate: 'located_in', re: /(расположен|находит|находится|регион|район|в [а-яё]+\s*(?:вод|траян)|located in|in the region|regiunea|situat|прож|афл)/iu },
    { predicate: 'part_of_region', re: /(входит в регион|часть региона|part of the region|parte a regiunii)/iu },
    { predicate: 'offers_tour', re: /(экскурс|тур|турах|tour|turul|ture|винный маршрут|маршрут)/iu },
    { predicate: 'offers_tasting', re: /(дегустац|tasting|degustare|дегуст)/iu },
]);

function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function isRoadmapPredicate(predicate) {
    return ROADMAP_PREDICATES.includes(predicate);
}

function isPublishable(predicate) {
    return RELATION_PREDICATES.includes(predicate);
}

function relationId(subjectId, predicate, objectKey) {
    const crypto = require('crypto');
    const source = `${subjectId}::${predicate}::${objectKey}`;
    const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
    return `rel_${hash}`;
}

function objectKeyFor({ objectId, objectValue, objectType }) {
    if (objectId) return `${objectType || 'entity'}:${objectId}`;
    return `${objectType || 'value'}:${String(objectValue || '')}`;
}

// Ingests one relation. Subject is always required (subject_id + subject_type).
// Object is either a registry entity (object_id + object_type) or a literal
// value (object_value). An empty/unknown predicate in the roadmap vocabulary is
// forced to needs_review + inactive by the caller policy below.
async function createRelation({
    subjectId,
    subjectType = 'winery',
    predicate,
    objectId = null,
    objectType = null,
    objectValue = null,
    confidence = 'medium',
    status = 'needs_review',
    active = null,
    sourceUrl = null,
    sourceType = 'general_web',
    sourceDomain = null,
    evidence = null,
    verifiedAt = null,
    expiresAt = null,
    changedBy = 'system',
} = {}, { pool = db.getPool() } = {}) {
    if (!subjectId || !predicate) {
        throw Object.assign(new Error('SUBJECT_AND_PREDICATE_REQUIRED'), { code: 'SUBJECT_AND_PREDICATE_REQUIRED' });
    }
    if (!['high', 'medium', 'low'].includes(confidence)) {
        throw Object.assign(new Error('INVALID_CONFIDENCE'), { code: 'INVALID_CONFIDENCE' });
    }
    if (objectId && !objectType) {
        throw Object.assign(new Error('OBJECT_ID_REQUIRES_OBJECT_TYPE'), { code: 'OBJECT_ID_REQUIRES_OBJECT_TYPE' });
    }
    if (objectValue == null && !objectId) {
        throw Object.assign(new Error('OBJECT_REQUIRED'), { code: 'OBJECT_REQUIRED' });
    }
    // Controlled vocabulary gate: roadmap predicates may be ingested; anything
    // else is stored as needs_review and never publishable.
    let validationStatus = VALIDATION_STATUSES.includes(status) ? status : 'needs_review';
    if (!isRoadmapPredicate(predicate)) validationStatus = 'needs_review';
    const publishable = isPublishable(predicate);
    // Never publishable => never active: a non-v1 predicate must not leak into
    // the production search path, even if a caller passes active=true (the
    // caller's flag may only narrow the default, never widen it past the
    // controlled v1 subset).
    const shouldBeActive = publishable && (active != null ? Boolean(active)
        : validationStatus === 'approved');

    const id = relationId(subjectId, predicate, objectKeyFor({ objectId, objectValue, objectType }));
    const row = {
        id,
        subject_id: subjectId,
        subject_type: subjectType,
        predicate,
        object_id: objectId,
        object_type: objectType,
        object_value: objectValue,
        confidence,
        validation_status: validationStatus,
        active: shouldBeActive,
        source_url: sourceUrl,
        source_type: sourceType,
        source_domain: sourceDomain,
        evidence,
        verified_at: verifiedAt || (shouldBeActive && publishable ? new Date().toISOString() : null),
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    if (pool) {
        await pool.query(`
            INSERT INTO entity_relations
                (id, subject_id, subject_type, predicate, object_id, object_type,
                 object_value, confidence, validation_status, active, source_url,
                 source_type, source_domain, evidence, verified_at, expires_at,
                 created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            ON CONFLICT (id) DO UPDATE SET
                subject_id = EXCLUDED.subject_id,
                subject_type = EXCLUDED.subject_type,
                predicate = EXCLUDED.predicate,
                object_id = EXCLUDED.object_id,
                object_type = EXCLUDED.object_type,
                object_value = EXCLUDED.object_value,
                confidence = EXCLUDED.confidence,
                validation_status = EXCLUDED.validation_status,
                active = EXCLUDED.active,
                source_url = EXCLUDED.source_url,
                source_type = EXCLUDED.source_type,
                source_domain = EXCLUDED.source_domain,
                evidence = EXCLUDED.evidence,
                verified_at = EXCLUDED.verified_at,
                expires_at = EXCLUDED.expires_at,
                updated_at = NOW()
        `, [
            row.id, row.subject_id, row.subject_type, row.predicate, row.object_id, row.object_type,
            row.object_value, row.confidence, row.validation_status, row.active, row.source_url,
            row.source_type, row.source_domain, row.evidence, row.verified_at, row.expires_at,
            row.created_at, row.updated_at,
        ]);
        await _writeHistory(pool, {
            relationId: row.id,
            action: 'created',
            prevStatus: null,
            newStatus: row.validation_status,
            changedBy,
            note: predicate in ROADMAP_PREDICATES ? null : 'outside controlled vocabulary',
        });
    }
    return row;
}

async function _writeHistory(pool, { relationId, action, prevStatus = null, newStatus, changedBy = 'system', note = null }) {
    if (!pool) return;
    const crypto = require('crypto');
    const hash = crypto.createHash('sha1').update(`${relationId}:${action}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
    await pool.query(`
        INSERT INTO entity_relations_history
            (id, relation_id, action, prev_status, new_status, changed_by, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [`relh_${hash}`, relationId, action, prevStatus, newStatus, changedBy, note]);
}

async function publishRelation(id, { status = 'approved', changedBy = 'editor' } = {}, { pool = db.getPool() } = {}) {
    if (status !== 'approved' && status !== 'validated') {
        throw Object.assign(new Error('INVALID_PUBLISH_STATUS'), { code: 'INVALID_PUBLISH_STATUS' });
    }
    if (!pool) return null;
    const existing = await getRelation(id, { pool });
    if (!existing) throw Object.assign(new Error('RELATION_NOT_FOUND'), { code: 'RELATION_NOT_FOUND' });
    if (!isPublishable(existing.predicate)) {
        throw Object.assign(new Error('PREDICATE_NOT_PUBLISHABLE'), { code: 'PREDICATE_NOT_PUBLISHABLE' });
    }
    if (pool) {
        await pool.query(`
            UPDATE entity_relations
            SET validation_status = $1, active = TRUE, verified_at = NOW(), updated_at = NOW()
            WHERE id = $2
        `, [status, id]);
        await _writeHistory(pool, {
            relationId: id,
            action: 'published',
            prevStatus: existing.validation_status,
            newStatus: status,
            changedBy,
        });
    }
    return { ...existing, validation_status: status, active: true };
}

async function rejectRelation(id, { changedBy = 'editor', note = null } = {}, { pool = db.getPool() } = {}) {
    if (!pool) return null;
    const existing = await getRelation(id, { pool });
    if (!existing) throw Object.assign(new Error('RELATION_NOT_FOUND'), { code: 'RELATION_NOT_FOUND' });
    if (pool) {
        await pool.query(`
            UPDATE entity_relations
            SET validation_status = 'rejected', active = FALSE, updated_at = NOW()
            WHERE id = $2 AND validation_status <> 'rejected'
        `, ['rejected', id]);
        await _writeHistory(pool, {
            relationId: id,
            action: 'rejected',
            prevStatus: existing.validation_status,
            newStatus: 'rejected',
            changedBy,
            note,
        });
    }
    return { ...existing, validation_status: 'rejected', active: false };
}

async function getRelation(id, { pool = db.getPool() } = {}) {
    if (!pool) return null;
    const { rows } = await pool.query(
        'SELECT * FROM entity_relations WHERE id = $1',
        [id]
    );
    return rows[0] || null;
}

async function queryRelations({
    subjectId = null,
    subjectType = null,
    predicate = null,
    objectId = null,
    objectValue = null,
    objectType = null,
    status = null,
    active = null,
    limit = 100,
} = {}, { pool = db.getPool() } = {}) {
    if (!pool) return [];
    const clauses = [];
    const params = [];
    if (subjectId) { params.push(subjectId); clauses.push(`subject_id = $${params.length}`); }
    if (subjectType) { params.push(String(subjectType)); clauses.push(`subject_type = $${params.length}`); }
    if (predicate) { params.push(String(predicate)); clauses.push(`predicate = $${params.length}`); }
    if (objectId) { params.push(String(objectId)); clauses.push(`object_id = $${params.length}`); }
    if (objectType) { params.push(String(objectType)); clauses.push(`object_type = $${params.length}`); }
    if (objectValue != null) { params.push(String(objectValue)); clauses.push(`object_value = $${params.length}`); }
    if (status) { params.push(String(status)); clauses.push(`validation_status = $${params.length}`); }
    if (active != null) { params.push(active); clauses.push(`active = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await pool.query(`
        SELECT * FROM entity_relations ${where}
        ORDER BY validation_status, confidence, verified_at DESC
        LIMIT $${params.length + 1}
    `, [...params, limit]);
    return rows;
}

async function getRelationStats({ pool = db.getPool() } = {}) {
    if (!pool) return { enabled: false, total: 0, by_predicate: {}, by_status: {}, by_type: {}, publishable: 0 };
    const { rows } = await pool.query('SELECT * FROM entity_relations');
    const byPredicate = {};
    const byStatus = {};
    const byType = {};
    for (const row of rows) {
        byPredicate[row.predicate] = (byPredicate[row.predicate] || 0) + 1;
        byStatus[row.validation_status] = (byStatus[row.validation_status] || 0) + 1;
        byType[row.subject_type] = (byType[row.subject_type] || 0) + 1;
    }
    return {
        enabled: true,
        total: rows.length,
        by_predicate: byPredicate,
        by_status: byStatus,
        by_type: byType,
        // Production-live relations: published (approved/validated) edges for
        // v1-publishable predicates with active=TRUE.
        publishable: rows.filter((row) => row.active === true
            && (row.validation_status === 'approved' || row.validation_status === 'validated')
            && isPublishable(row.predicate)).length,
    };
}

// Predicate hints present in the question; returns the roadmap predicates the
// question most likely asks about, deduplicated in vocabulary order.
function detectPredicates(query) {
    const norm = String(query || '').toLocaleLowerCase();
    const found = [];
    for (const hint of PREDICATE_HINTS) {
        if (!isPublishable(hint.predicate)) continue;
        if (hint.re.test(norm) && !found.includes(hint.predicate)) found.push(hint.predicate);
    }
    return found;
}

function subjectLabel(subjectId) {
    const entity = findByEntityId(subjectId);
    return entity ? entity.canonicalName || subjectId : subjectId;
}

function objectLabel(row) {
    if (row.object_id) {
        return findByEntityId(row.object_id)?.canonicalName || row.object_id;
    }
    return String(row.object_value || '');
}

// Relation-aware canonical retrieval. Returns [] (not an error) when the
// question cannot be resolved to room for relation evidence, so the router
// falls through to the existing fuzzy canonical/document search untouched.
// Multi-condition semantic: resolved entities constrain BOTH sides of edges
// (subject and object) and predicate hints constrain the predicate set; the
// resulting rows are all edges that satisfy every gathered condition.
async function searchRelations(query, options = {}) {
    const pool = options.pool || db.getPool();
    if (!pool || !query) return [];
    const mentioned = findMentionedEntities(String(query));
    if (!mentioned.length) return [];
    const predicates = detectPredicates(String(query));

    const rows = await queryRelations({ active: true, limit: 500 }, { pool });

    // Gather conditions from resolved entities. A mention constrains a winery/
    // wine subject (e.g. "винодельни Кодру" => subjects located_in codru) via
    // object-side edges, so conditions are built from both mention types.
    const repoEntities = [];
    const regionEntities = [];
    const grapeEntities = [];
    const wineEntities = [];
    for (const mention of mentioned) {
        const type = mention.entityType || 'unknown';
        if (type === 'wine_region') regionEntities.push(mention);
        else if (type === 'grape' || type === 'grape_variety') grapeEntities.push(mention);
        else if (type === 'wine') wineEntities.push(mention);
        else repoEntities.push(mention); // winery / platform / divin-producer
    }

const poolRows = rows.filter((row) => row.active === true
    && (row.validation_status === 'approved' || row.validation_status === 'validated')
    && isPublishable(row.predicate));
if (!poolRows.length) return [];

const regionIds = new Set(regionEntities.map((m) => m.entityId));
const grapeIds = new Set(grapeEntities.map((m) => m.entityId));
const entityIds = new Set([...repoEntities, ...wineEntities].map((m) => m.entityId));

// Candidate subjects: subjects that appear on at least one active edge. Rows
// are grouped per subject so predicate coverage is checked per subject.
const rowsBySubject = new Map();
for (const row of poolRows) {
    const subject = String(row.subject_id);
    if (!rowsBySubject.has(subject)) rowsBySubject.set(subject, []);
    rowsBySubject.get(subject).push(row);
}

// A subject survives when every applicable condition is satisfied by at least
// one of ITS edges:
//  - every detected predicate must be present among its edges;
//  - every mentioned region must appear as the object of a located_in /
//    part_of_region edge (the region is the subject's location);
//  - every mentioned winery/wine must be the subject itself or the object of a
//    produces/made_from edge (named entity questions narrow to that entity);
//  - every mentioned grape must appear as the object of a made_from / uses_grape
//    edge.
const matched = [];
for (const [subjectId, subjectRows] of rowsBySubject) {
    const predicatesPresent = new Set(subjectRows.map((r) => r.predicate));
    if (predicates.length && !predicates.every((p) => predicatesPresent.has(p))) continue;

    let regionOk = true;
    for (const rid of regionIds) {
        if (!subjectRows.some((r) => (r.predicate === 'located_in' || r.predicate === 'part_of_region')
            && String(r.object_id || '') === rid)) {
            regionOk = false;
            break;
        }
    }
    if (!regionOk) continue;

    let entityOk = true;
    for (const eid of entityIds) {
        if (subjectId !== eid
            && !subjectRows.some((r) => String(r.object_id || '') === eid)) {
            entityOk = false;
            break;
        }
    }
    if (!entityOk) continue;

    let grapeOk = true;
    for (const gid of grapeIds) {
        if (!subjectRows.some((r) => String(r.object_id || '') === gid)) {
            grapeOk = false;
            break;
        }
    }
    if (!grapeOk) continue;

    matched.push({ subjectId, rows: subjectRows });
}

    if (!matched.length) return [];

    const items = [];
    for (const { subjectId, rows: subjectRows } of matched.slice(0, options.limit || 8)) {
        const label = subjectLabel(subjectId);
        for (const row of subjectRows.slice(0, 4)) {
            const predicateLabel = row.predicate;
            const object = objectLabel(row);
            items.push({
                level: 'canonical',
                structured: true,
                structured_kind: 'entity_relation',
                text: `${label} — ${predicateLabel}: ${object}`,
                title: label,
                source: row.source_url || row.source_domain || 'entity_relations',
                source_type: 'relation',
                confidence: row.validation_status === 'approved' && row.confidence === 'high' ? 'verified' : row.confidence,
                provenance: {
                    entity_id: subjectId,
                    relation_id: row.id,
                    predicate: row.predicate,
                    object_id: row.object_id,
                    object_type: row.object_type,
                    object_value: row.object_value,
                    validation_status: row.validation_status,
                    verified_at: row.verified_at,
                    expires_at: row.expires_at,
                },
                relation: {
                    subject_id: subjectId,
                    subject_type: row.subject_type,
                    predicate: row.predicate,
                    object_id: row.object_id,
                    object_type: row.object_type,
                    object_value: row.object_value,
                },
            });
        }
    }
    return items;
}

module.exports = {
    ENTITY_TYPES,
    ROADMAP_PREDICATES,
    RELATION_PREDICATES,
    VALIDATION_STATUSES,
    createRelation,
    publishRelation,
    rejectRelation,
    getRelation,
    queryRelations,
    getRelationStats,
    searchRelations,
    detectPredicates,
    relationId,
    isPublishable,
    isRoadmapPredicate,
    objectKeyFor,
};
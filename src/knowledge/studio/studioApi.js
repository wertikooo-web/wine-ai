'use strict';

// Knowledge Studio HTTP API (Phase 5) — thin, read/write surface over
// studioStore so an editor can repair production knowledge without direct
// PostgreSQL access, from a browser admin page. Follows the server's existing
// convention: JSON bodies, `{ ok: true, ... }` envelopes, no bundler, and no
// secrets in any payload.
//
// Route map (all under /api/studio):
//   GET    /api/studio/entities?q=            → searchEntities
//   GET    /api/studio/entities/:entityId     → getEntityCard (facts, relations,
//                                               aliases, history, provenance)
//   GET    /api/studio/queues                 → getReviewQueues
//   GET    /api/studio/predicates             → relation vocabulary for the UI
//   POST   /api/studio/facts                  → createFactEdit
//   POST   /api/studio/facts/:id/review       → reviewFact {action}
//   POST   /api/studio/facts/:id/rollback     → rollbackFact
//   POST   /api/studio/relations              → createRelationEdit
//   POST   /api/studio/relations/:id/review   → reviewRelation {action}
//   POST   /api/studio/relations/:id/rollback → rollbackRelation
//   POST   /api/studio/aliases                → createAliasEdit
//   POST   /api/studio/aliases/:id/review     → reviewAliasEdit {action}
//   POST   /api/studio/aliases/:id/rollback   → rollbackAliasEdit
//   POST   /api/studio/merge                  → mergeEntities {keepId, mergeId}

const db = require('../db');
const store = require('./studioStore');
const relations = require('../entityRelations');

function normalizeBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return body;
}

function pick(body, ...keys) {
    const out = {};
    for (const key of keys) {
        if (body[key] !== undefined) out[key] = body[key];
    }
    return out;
}

function requirePool() {
    if (!db.isEnabled()) {
        const error = new Error('Knowledge Studio requires PostgreSQL (DATABASE_URL). The file-backed local mode cannot persist studio edits.');
        error.code = 'DATABASE_REQUIRED';
        throw error;
    }
}

function httpError(error) {
    const statusByCode = {
        FACT_REQUIRED: 400,
        INVALID_CONFIDENCE: 400,
        FACT_NOT_FOUND: 404,
        FACT_ALREADY_REVIEWED: 409,
        SUBJECT_AND_PREDICATE_REQUIRED: 400,
        OBJECT_ID_REQUIRES_OBJECT_TYPE: 400,
        OBJECT_REQUIRED: 400,
        PREDICATE_NOT_IN_VOCABULARY: 400,
        RELATION_NOT_FOUND: 404,
        ALIAS_REQUIRED: 400,
        INVALID_ALIAS_ACTION: 400,
        RENAME_REQUIRES_PREV_ALIAS: 400,
        ENTITY_NOT_IN_REGISTRY: 400,
        ALIAS_EDIT_NOT_FOUND: 404,
        ALIAS_EDIT_ALREADY_REVIEWED: 409,
        ALIAS_EDIT_NOT_APPROVED: 409,
        INVALID_REVIEW_ACTION: 400,
        MERGE_REQUIRES_TWO_DISTINCT_ENTITIES: 400,
        MERGE_ENTITY_NOT_IN_REGISTRY: 400,
        DATABASE_REQUIRED: 503,
    };
    const status = statusByCode[error.code] || 500;
    return { status, body: { ok: false, error: error.code || 'studio_error', message: error.message } };
}

function handleGet(pathname, segments, requestUrl, res, sendJson) {
    if (segments.length === 1 && pathname === '/api/studio/predicates') {
        return sendJson(res, 200, {
            ok: true,
            predicates: relations.ROADMAP_PREDICATES,
            all_predicates: relations.RELATION_PREDICATES,
            entity_types: relations.ENTITY_TYPES,
            fact_history_actions: store.FACT_HISTORY_ACTIONS,
            alias_actions: store.ALIAS_EDIT_ACTIONS,
            alias_statuses: store.ALIAS_EDIT_STATUSES,
            database_enabled: db.isEnabled(),
        });
    }

    if (segments.length === 1 && pathname === '/api/studio/queues') {
        return store.getReviewQueues()
            .then((result) => sendJson(res, 200, { ok: true, ...result }))
            .catch((error) => {
                const { status, body } = httpError(error);
                return sendJson(res, status, body);
            });
    }

    if (segments.length === 1 && pathname === '/api/studio/entities') {
        const q = requestUrl.searchParams.get('q') || '';
        return store.searchEntities(q)
            .then((entities) => sendJson(res, 200, { ok: true, entities }))
            .catch((error) => {
                const { status, body } = httpError(error);
                return sendJson(res, status, body);
            });
    }

    if (segments.length === 2 && segments[0] === 'entities') {
        const entityId = segments[1];
        return store.getEntityCard(entityId)
            .then((card) => sendJson(res, 200, { ok: true, card }))
            .catch((error) => {
                const { status, body } = httpError(error);
                return sendJson(res, status, body);
            });
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

function handlePost(pathname, segments, body, res, sendJson) {
    const payload = normalizeBody(body);

    if (segments.length === 1 && pathname === '/api/studio/facts') {
        try {
            requirePool();
            return store.createFactEdit(pick(payload,
                'entityId', 'entityType', 'fieldName', 'value', 'sourceUrl', 'sourceType',
                'confidence', 'evidence', 'changedBy', 'note'
            ))
                .then((fact) => sendJson(res, 201, { ok: true, fact }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'facts' && segments[2] === 'review') {
        try {
            requirePool();
            return store.reviewFact(segments[1], pick(payload, 'action', 'changedBy', 'note'))
                .then((fact) => sendJson(res, 200, { ok: true, fact }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'facts' && segments[2] === 'rollback') {
        try {
            requirePool();
            return store.rollbackFact(segments[1], pick(payload, 'changedBy', 'note'))
                .then((fact) => sendJson(res, 200, { ok: true, fact }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 1 && pathname === '/api/studio/relations') {
        try {
            requirePool();
            return store.createRelationEdit(pick(payload,
                'subjectId', 'subjectType', 'predicate', 'objectId', 'objectType',
                'objectValue', 'confidence', 'sourceUrl', 'sourceType', 'evidence',
                'changedBy', 'note'
            ))
                .then((relation) => sendJson(res, 201, { ok: true, relation }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'relations' && segments[2] === 'review') {
        try {
            requirePool();
            return store.reviewRelation(segments[1], pick(payload, 'action', 'changedBy', 'note'))
                .then((relation) => sendJson(res, 200, { ok: true, relation }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'relations' && segments[2] === 'rollback') {
        try {
            requirePool();
            return store.rollbackRelation(segments[1], pick(payload, 'changedBy', 'note'))
                .then((relation) => sendJson(res, 200, { ok: true, relation }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 1 && pathname === '/api/studio/aliases') {
        try {
            requirePool();
            return store.createAliasEdit(pick(payload,
                'entityId', 'alias', 'language', 'action', 'prevAlias', 'changedBy', 'note'
            ))
                .then((edit) => sendJson(res, 201, { ok: true, edit }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'aliases' && segments[2] === 'review') {
        try {
            requirePool();
            return store.reviewAliasEdit(segments[1], pick(payload, 'action', 'changedBy', 'note'))
                .then((edit) => sendJson(res, 200, { ok: true, edit }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 3 && segments[0] === 'aliases' && segments[2] === 'rollback') {
        try {
            requirePool();
            return store.rollbackAliasEdit(segments[1], pick(payload, 'changedBy', 'note'))
                .then((edit) => sendJson(res, 200, { ok: true, edit }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    if (segments.length === 1 && pathname === '/api/studio/merge') {
        try {
            requirePool();
            return store.mergeEntities(pick(payload, 'keepId', 'mergeId', 'changedBy', 'note'))
                .then((result) => sendJson(res, 200, { ok: true, ...result }))
                .catch((error) => {
                    const { status, body: out } = httpError(error);
                    return sendJson(res, status, out);
                });
        } catch (error) {
            const { status, body: out } = httpError(error);
            return sendJson(res, status, out);
        }
    }

    return sendJson(res, 404, { ok: false, error: 'not_found' });
}

function createStudioApi({ sendJson, readJsonBody }) {
    return {
        async handle(req, res, pathname, requestUrl) {
            if (!pathname.startsWith('/api/studio')) return false;
            const segments = pathname.split('/').filter(Boolean).slice(2);
            if (req.method === 'GET') {
                await handleGet(pathname, segments, requestUrl, res, sendJson);
                return true;
            }
            if (req.method === 'POST') {
                let body;
                try {
                    body = await readJsonBody(req);
                } catch (error) {
                    sendJson(res, error.code === 'body_too_large' ? 413 : 400, { ok: false, error: error.code || 'invalid_request' });
                    return true;
                }
                await handlePost(pathname, segments, body, res, sendJson);
                return true;
            }
            sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
            return true;
        },
    };
}

module.exports = { createStudioApi };

'use strict';

/**
 * WINE AI KOS - Canonical Object Serialization Candidate Fingerprint (Step 3A Refined)
 *
 * Generates a stable, deterministic SHA-256 candidate ID via Canonical JSON Serialization.
 * Rejects ambiguity, delimiter collisions, NaN/Infinity/undefined, and random values.
 */

const crypto = require('crypto');
const { canonicalizeEntityRef } = require('../contracts/factCandidate');

function canonicalizeValue(val, seen = new WeakSet()) {
    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') {
        throw new TypeError(`Cannot canonicalize invalid value type: ${typeof val}`);
    }

    if (val === null || typeof val === 'boolean') {
        return val;
    }

    if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
            throw new TypeError(`Cannot canonicalize non-finite number: ${val}`);
        }
        return val;
    }

    if (typeof val === 'string') {
        return val.normalize('NFC');
    }

    if (typeof val === 'object') {
        if (seen.has(val)) {
            throw new TypeError('Cannot canonicalize cyclic object graph.');
        }
        seen.add(val);

        if (Array.isArray(val)) {
            const arrResult = val.map((item) => canonicalizeValue(item, seen));
            seen.delete(val);
            return arrResult;
        }

        const sortedKeys = Object.keys(val).sort();
        const objResult = {};
        for (const key of sortedKeys) {
            const v = val[key];
            if (v !== undefined) {
                objResult[key] = canonicalizeValue(v, seen);
            }
        }
        seen.delete(val);
        return objResult;
    }

    throw new TypeError(`Unsupported value type: ${typeof val}`);
}

function canonicalJsonStringify(val) {
    const canonicalObj = canonicalizeValue(val);
    return JSON.stringify(canonicalObj);
}

function canonicalizeEvidenceForFingerprint(evidenceList) {
    if (!Array.isArray(evidenceList)) return [];

    return evidenceList.map((ev) => {
        const spans = Array.isArray(ev.spans)
            ? ev.spans.map((s) => ({
                quote: String(s.quote || '').normalize('NFC'),
                range: {
                    representation: 'canonical-v1',
                    utf16Start: Number(s.range?.utf16Start || 0),
                    utf16End: Number(s.range?.utf16End || 0),
                },
            }))
            : [];

        // Sort spans by utf16Start
        spans.sort((a, b) => a.range.utf16Start - b.range.utf16Start || a.range.utf16End - b.range.utf16End);

        return {
            sourceId: String(ev.sourceId || ''),
            sourceChecksum: String(ev.sourceChecksum || ''),
            documentFingerprint: String(ev.documentFingerprint || ''),
            spans,
        };
    }).sort((a, b) => {
        const cmp = a.sourceId.localeCompare(b.sourceId);
        if (cmp !== 0) return cmp;
        const startA = a.spans[0]?.range?.utf16Start || 0;
        const startB = b.spans[0]?.range?.utf16Start || 0;
        return startA - startB;
    });
}

function generateCandidateId(data = {}) {
    const evidenceList = Array.isArray(data.evidence) ? data.evidence : (Array.isArray(data.evidenceDrafts) ? data.evidenceDrafts : []);
    const firstEvidence = evidenceList[0] || {};

    const sourceChecksum = String(data.sourceChecksum || firstEvidence.sourceChecksum || '');
    const documentFingerprint = String(data.documentFingerprint || firstEvidence.documentFingerprint || '');
    const entityType = String(data.entityType || '').trim().toLowerCase();
    const entityRef = canonicalizeEntityRef(data.entityRef);
    const fieldPath = String(data.fieldPath || '').trim().toLowerCase();
    const valueType = String(data.valueType || 'string').trim().toLowerCase();

    const normalizedValue = data.normalizedValue !== undefined ? data.normalizedValue : null;
    const extractorName = String(data.extractor?.name || 'kos-extractor').trim().toLowerCase();
    const extractorVersion = String(data.extractor?.version || '1.0.0').trim().toLowerCase();

    const payload = {
        schemaVersion: '1.0.0',
        sourceChecksum,
        documentFingerprint,
        entityType,
        entityRef,
        fieldPath,
        valueType,
        normalizedValue,
        evidence: canonicalizeEvidenceForFingerprint(evidenceList),
        extractor: {
            name: extractorName,
            version: extractorVersion,
        },
    };

    const canonicalJson = canonicalJsonStringify(payload);
    return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

module.exports = {
    canonicalizeValue,
    canonicalJsonStringify,
    generateCandidateId,
};

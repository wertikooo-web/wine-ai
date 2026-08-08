'use strict';

// Shared canonical SOURCE CONTRACT for the versioned corpus.
//
// Both the manifest audit (corpus-manifest-audit.js) and the Versioned Corpus
// Builder (builder.js) must agree on ONE definition of "the content of a
// source", so the build-time input pin can never flag drift for an unchanged
// document. If these two paths hash different bytes, versioning periodically
// reports "SOURCE_FETCH_FAILED" for the same logical document (different reads
// of the same bottle), which breaks reproducibility.
//
// The contract here is the single source of truth for:
//   - the canonical TEXT of a source (what gets hashed AND chunked),
//   - the canonical HASH of that text (what is pinned/compared),
//   - the pinned version key precedence (how each source kind resolves it),
//   - the allowed storage backends (identity of where the byte lives).
//
// Everything else (chunking, embedding, build lifecycle) may live elsewhere,
// but the text -> hash mapping goes through this module only.

const crypto = require('crypto');

function sha256Text(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

// Canonical text of a source body. Trailing/leading whitespace is NOT part of
// the document's content and is trimmed here and only here, so the manifest,
// the builder pin, and the chunker all operate on the same bytes. Missing
// content normalizes to the empty string (never the string 'undefined').
function canonicalText(text) {
    if (text == null) return '';
    return String(text).trim();
}

// Canonical hash of a source body. Must be used by BOTH the manifest audit
// (to pin) and the builder (to verify at fetch time).
function canonicalTextHash(text) {
    return sha256Text(canonicalText(text));
}

// Resolve the pinned version key for an audited source entry, mirroring the
// audit's own hash fields per source kind (kos text / disc text / curated
// body). NFT: prefer the canonical body hash; fall back to the DB content hash
// only when the human-authored normalized text is absent.
function pinnedVersionKey(entry) {
    const h = entry.hashes || {};
    return h.normalized_text_sha256 || h.text_sha256 || h.body_sha256 || h.content_hash_db || h.raw_sha256 || null;
}

// Only these storage backends are canonical. Every source pins to one of them,
// and the builder never interpolates a manifest-controlled identifier into SQL.
const POSTGRES_STORAGE = new Map([
    ['kos_source_documents.normalized_text', { table: 'kos_source_documents', column: 'normalized_text' }],
    ['knowledge_documents.text', { table: 'knowledge_documents', column: 'text' }],
]);

function parseStorage(storage) {
    const value = String(storage || '');
    if (value.startsWith('postgres:')) {
        const key = value.slice('postgres:'.length);
        const target = POSTGRES_STORAGE.get(key);
        if (!target) {
            const err = new Error(`UNKNOWN_SOURCE_STORAGE: ${value}`);
            err.code = 'UNKNOWN_SOURCE_STORAGE';
            throw err;
        }
        return { kind: 'postgres', ...target };
    }
    if (value.startsWith('filesystem:')) {
        const file = value.slice('filesystem:'.length);
        if (!file) {
            const err = new Error(`UNKNOWN_SOURCE_STORAGE: ${value}`);
            err.code = 'UNKNOWN_SOURCE_STORAGE';
            throw err;
        }
        return { kind: 'filesystem', file };
    }
    const err = new Error(`UNKNOWN_SOURCE_STORAGE: ${value}`);
    err.code = 'UNKNOWN_SOURCE_STORAGE';
    throw err;
}

module.exports = {
    sha256Text,
    canonicalText,
    canonicalTextHash,
    pinnedVersionKey,
    parseStorage,
    POSTGRES_STORAGE,
};
'use strict';

// Locks the source vending contract: manifest audit and Versioned Corpus
// Builder MUST hash exactly the same bytes (the trimmed canonical body), so a
// trailing/leading-whitespace change in the DB can never present as "drift" for
// an unchanged document. These tests pin the shared helper's invariants.

const assert = require('assert');
const contract = require('../src/buildRegistry/sourceContract');

function run() {
    let assertionCount = 0;
    const a = (cond, msg) => { assertionCount += 1; assert.ok(cond, msg); };
    const eq = (got, want, msg) => { assertionCount += 1; assert.strictEqual(got, want, msg); };

    // --- canonical text trims, and only the canonical bytes are hashed ---
    {
        const WITH_WS = '\n  Alpha body about Moldova wine.  \t\n';
        eq(contract.canonicalText(WITH_WS), 'Alpha body about Moldova wine.');
        eq(contract.canonicalTextHash(WITH_WS), contract.canonicalTextHash('Alpha body about Moldova wine.'));
        a(contract.canonicalTextHash(WITH_WS) !== contract.sha256Text(WITH_WS), 'raw-vs-canonical hashes differ');
    }

    // --- canonical hash is the trimmed-body pin that manifests emit ---
    {
        const bodyA = 'Vino alb sec de Moldova.';
        const bodyB = ' Vino alb sec de Moldova.';
        eq(contract.canonicalTextHash(bodyA), contract.canonicalTextHash(bodyB), 'trailing ws is not a version change');
        eq(contract.canonicalTextHash(bodyA).length, 64, 'sha256 hex length');
    }

    // --- whitespace-only bodies are empty content (canonicalText -> '') ---
    {
        eq(contract.canonicalText('   \n\t  '), '');
        eq(contract.canonicalText(undefined), '');
        eq(contract.canonicalText(null), '');
    }

    // --- pinned version key precedence mirrors the audit hash fields ---
    {
        const entry = {
            hashes: {
                normalized_text_sha256: 'nts',
                text_sha256: 'ts',
                body_sha256: 'bs',
                content_hash_db: 'cdb',
                raw_sha256: 'raw',
            },
        };
        eq(contract.pinnedVersionKey(entry), 'nts', 'normalized_text_sha256 wins for KOS-like');
        delete entry.hashes.normalized_text_sha256;
        eq(contract.pinnedVersionKey(entry), 'ts', 'text_sha256 wins for discovered-like');
        delete entry.hashes.text_sha256;
        eq(contract.pinnedVersionKey(entry), 'bs', 'body_sha256 wins for curated-like');
        delete entry.hashes.body_sha256;
        eq(contract.pinnedVersionKey(entry), 'cdb', 'content_hash_db fallback');
        eq(contract.pinnedVersionKey({ hashes: {} }), null, 'no pin -> null');
    }

    // --- storage parse: allow-list only for postgres ---
    {
        const pg = contract.parseStorage('postgres:kos_source_documents.normalized_text');
        eq(pg.kind, 'postgres');
        eq(pg.table, 'kos_source_documents');
        eq(pg.column, 'normalized_text');
        eq(contract.parseStorage('filesystem:knowledge/source/cricova.md').kind, 'filesystem');
        let code = null;
        try { contract.parseStorage('postgres:evil_table.column'); } catch (e) { code = e.code; }
        eq(code, 'UNKNOWN_SOURCE_STORAGE', 'unlisted postgres storage rejected');
        eq(contract.parseStorage('filesystem:../../etc/passwd').kind, 'filesystem', 'filesystem path structural parse');
    }

    // --- canonical hash == sha256 of trimmed body ---
    {
        eq(contract.canonicalTextHash('Alpha'), contract.sha256Text('Alpha'));
        eq(contract.canonicalTextHash('\n  Alpha  '), contract.sha256Text('Alpha'));
    }

    console.log(`sourceContract: ${assertionCount} assertions OK`);
    return { assertionCount };
}

module.exports = { run };
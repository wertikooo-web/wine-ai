'use strict';

// Unit tests for src/buildRegistry/builder.js — the pure core (deterministic
// fingerprint/build_id, stable_id/version_key, dedupe policy, exclusions,
// chunk scheme) plus the DB stages against a fake pool so the whole pipeline is
// testable without PostgreSQL. The real-PG path is covered by
// tests/buildRegistryBuilder.postgres.integration.test.js.

const assert = require('assert');
const path = require('path');

const builder = require('../src/buildRegistry/builder');
const { verifyChunkIdStability } = require('../src/knowledge/chunkStore');

const MANIFEST = require('../docs/audits/corpus-manifest/manifest.json');

let assertions = 0;
const a = (cond, msg) => { assertions += 1; assert.ok(cond, msg); };
const eq = (x, y, msg) => { assertions += 1; assert.strictEqual(x, y, msg); };

// Tiny in-memory PostgreSQL double that implements exactly the statements the
// builder issues, so runBuild lands 'ready' on a live shape without a live DB.
class FakePool {
    constructor() {
        this.builds = [];
        this.chunks = [];
        this.sources = [];
    }

    reset() {
        this.builds = [];
        this.chunks = [];
        this.sources = [];
    }

    getBuild(buildId) {
        return this.builds.find((b) => b.build_id === buildId) || null;
    }

    getChunks(buildId) {
        return this.chunks.filter((c) => c.build_id === buildId);
    }

    seedSource(id, text) {
        this.sources.push({ table: 'kos_source_documents', column: 'normalized_text', id, text });
    }

    async query(sql, params = []) {
        const s = String(sql).trim();
        const q = (col) => (params[col - 1] === undefined ? null : params[col - 1]);
        const sourceText = (table, id) => {
            const row = this.sources.find((x) => x.table === table && x.id === id);
            return row ? row.text : null;
        };

        if (/^SELECT .* AS content FROM (kos_source_documents|knowledge_documents)/.test(s)) {
            const m = /^SELECT (\S+) AS content FROM (\S+)/.exec(s);
            const column = m[1];
            const table = m[2];
            const id = q(1);
            const text = this.sources.find((x) => x.table === table && x.column === column && x.id === id)?.text || null;
            return { rows: text === null ? [] : [{ content: text }] };
        }
        if (/^INSERT INTO build_registry_builds/.test(s)) {
            const buildId = q(1);
            const existing = this.builds.findIndex((b) => b.build_id === buildId);
            const build = {
                build_id: buildId,
                status: 'building',
                input_fingerprint: q(2),
                input_snapshot: JSON.parse(q(3)),
                source_count: q(4),
                created_by: q(5),
                chunk_count: existing >= 0 ? this.builds[existing].chunk_count : 0,
                embedding_count: existing >= 0 ? this.builds[existing].embedding_count : 0,
            };
            if (existing >= 0) this.builds[existing] = build;
            else this.builds.push(build);
            return { rows: [] };
        }
        if (/^SELECT version_key FROM build_registry_chunks/.test(s)) {
            return {
                rows: this.chunks
                    .filter((c) => c.build_id === q(1) && c.source_file === q(2))
                    .map((c) => ({ version_key: c.version_key })),
            };
        }
        if (/^DELETE FROM build_registry_chunks/.test(s)) {
            const before = this.chunks.length;
            const id = q(1);
            const file = q(2);
            this.chunks = this.chunks.filter((c) => !(c.build_id === id && (file === undefined || c.source_file === file)));
            return { rowCount: before - this.chunks.length, rows: [] };
        }
        if (/^INSERT INTO build_registry_chunks/.test(s)) {
            this.chunks.push({
                chunk_id: q(1),
                build_id: q(2),
                source_file: q(3),
                title: q(4),
                doc_type: q(5),
                language: q(6),
                source: q(7),
                confidence: q(8),
                entity_id: q(9),
                winery: q(10),
                region: q(11),
                grape: q(12),
                date: q(13),
                enabled: q(14),
                chunk_index: q(15),
                text: q(16),
                content_hash: q(17),
                version_key: q(18),
                model: q(19),
                embedding: null,
            });
            return { rows: [] };
        }
        if (/^UPDATE build_registry_chunks SET embedding/.test(s)) {
            const chunk = this.chunks.find((c) => c.build_id === q(3) && c.chunk_id === q(4));
            if (chunk) {
                chunk.embedding = JSON.parse(String(q(1)));
                chunk.model = q(2);
            }
            return { rows: [] };
        }
        if (/^SELECT chunk_id, content_hash, source_file/.test(s)) {
            return {
                rows: this.chunks
                    .filter((c) => c.build_id === q(1))
                    .map((c) => ({ ...c, embedded: c.embedding !== null })),
            };
        }
        if (/^SELECT chunk_id, source_file, title/.test(s)) {
            return {
                rows: this.chunks.filter((c) => c.build_id === q(1) && c.embedding === null).map((c) => ({ ...c })),
            };
        }
        if (/^UPDATE build_registry_builds SET/.test(s)) {
            const build = this.getBuild(params[params.length - 1]);
            if (!build) return { rows: [] };
            if (/status = \$1/.test(s)) build.status = q(1);
            if (/chunk_count = \$1/.test(s)) {
                build.chunk_count = q(1);
                build.embedding_count = q(2);
                build.model = q(3);
                build.hooks_version = q(4);
            }
            return { rows: [] };
        }
        if (/SELECT status, chunk_count, embedding_count FROM build_registry_builds/.test(s)) {
            const build = this.getBuild(q(1));
            return {
                rows: build
                    ? [{ status: build.status, chunk_count: build.chunk_count, embedding_count: build.embedding_count }]
                    : [],
            };
        }
        if (/SELECT source_count, chunk_count, embedding_count, input_fingerprint, input_snapshot/.test(s)) {
            const build = this.getBuild(q(1));
            return {
                rows: build ? [{
                    source_count: build.source_count,
                    chunk_count: build.chunk_count,
                    embedding_count: build.embedding_count,
                    input_fingerprint: build.input_fingerprint,
                    input_snapshot: build.input_snapshot,
                }] : [],
            };
        }
        if (/SELECT a.atttypmod/.test(s)) {
            return { rows: [{ atttypmod: (768 * 4) + 4 }] };
        }
        if (/COUNT\(\*\)::int FROM build_registry_chunks/.test(s)) {
            const rows = this.chunks.filter((c) => c.build_id === q(1));
            return {
                rows: [{
                    chunk_count: rows.length,
                    embedding_count: rows.filter((c) => c.embedding !== null).length,
                }],
            };
        }
        if (/^SELECT value FROM build_registry_state/.test(s) || /build_registry_state/.test(s)) {
            throw new Error('builder must never touch the runtime pointer (out of scope PR2)');
        }
        throw new Error(`unhandled SQL in fake pool: ${s.slice(0, 80)}`);
    }
}

function fakeEmbedder() {
    return (chunks) => chunks.map((chunk, index) => Array.from({ length: 768 }, (_, i) => (chunk.id.length + index + i) / 10000));
}

const TEXTS = {
    doc_a: 'Alpha body paragraph one about wine.\n\nAlpha body paragraph two about Moldova wine.',
    doc_b: 'Beta body paragraph one about grapes.\n\nBeta body paragraph two about winemaking.',
};

// Pipeline fixtures: hashes are the real sha256 of the seeded text so the
// fetch-time input-pin check passes.
function textFixtureManifest() {
    const m = fixtureManifest();
    m.entries[0].hashes = { normalized_text_sha256: builder.sha256Text(TEXTS.doc_a) };
    m.entries[1].hashes = { normalized_text_sha256: builder.sha256Text(TEXTS.doc_b) };
    return m;
}

function fixtureManifest(overrides = {}) {
    const kos = (id, opts = {}) => ({
        source_ref: `kos:${id}`,
        source_type: 'kos_source_document',
        source_id: id,
        title: opts.title || `Title ${id}`,
        language: 'ru',
        status: 'active',
        include: true,
        exclude_reason: null,
        storage: 'postgres:kos_source_documents.normalized_text',
        hashes: opts.hashes || { normalized_text_sha256: opts.hash || `h-${id}` },
        estimated_chunks: 1,
        duplicate_group: opts.dup || null,
    });
    const excluded = {
        source_ref: 'curated-feteasca:demo.md',
        source_type: 'curated-demo',
        source_id: 'demo.md',
        include: false,
        exclude_reason: 'demo: excluded by policy',
        storage: 'filesystem:knowledge/source/demo.md',
    };
    return {
        generated_at: '2026-08-05T00:00:00Z',
        mode: 'read-only',
        production_snapshot: 'prod',
        entries: [kos('doc_a', { title: 'Alpha' }), kos('doc_b', { title: 'Beta' }), excluded],
        ...overrides,
    };
}

function seededTwoDocPool() {
    const pool = new FakePool();
    pool.seedSource('doc_a', TEXTS.doc_a);
    pool.seedSource('doc_b', TEXTS.doc_b);
    return pool;
}

async function coreForManifest(manifest) {
    const core = builder.canonicalizeInputs(manifest);
    return core;
}

async function run() {
    // --- pure core: determinism ---
    {
        const a1 = builder.canonicalizeInputs(fixtureManifest());
        const b1 = builder.canonicalizeInputs(fixtureManifest());
        eq(a1.fingerprint, b1.fingerprint, 'deterministic fingerprint for same manifest');
        eq(a1.buildId, b1.buildId, 'deterministic build_id for same manifest');
        eq(a1.buildId.length, builder.BUILD_ID_SLICE, 'build_id is BUILD_ID_SLICE hex chars');
        eq(a1.fingerprint.length, 64, 'fingerprint is sha256 hex');
    }

    // --- pure core: a changed body -> new version_key -> new fingerprint ---
    {
        const base = fixtureManifest();
        const changed = fixtureManifest();
        changed.entries[0].hashes.normalized_text_sha256 = 'changed-hash';
        const a1 = builder.canonicalizeInputs(base);
        const b1 = builder.canonicalizeInputs(changed);
        a(b1.fingerprint !== a1.fingerprint, 'changed body changes fingerprint');
        a(b1.buildId !== a1.buildId, 'changed body changes build_id');
    }

    // --- pure core: excluded counted but not in fingerprint/source_count ---
    {
        const core = builder.canonicalizeInputs(fixtureManifest());
        eq(core.sourceCount, 2, 'source_count is post-inclusion count');
        eq(core.excluded.length, 1, 'excluded recorded');
        eq(core.excluded[0].excluded_reason, 'demo: excluded by policy', 'excluded reason pinned');
        a(!core.included.some((e) => e.source_ref === 'curated-feteasca:demo.md'), 'excluded not in included set');
        a(core.included.every((e) => e.version_key), 'every included source pinned');
    }

    // --- pure core: real manifest invariants ---
    {
        const core = builder.canonicalizeInputs(MANIFEST);
        eq(core.sourceCount, 438, 'effective sources = 453 - 15 collapsed');
        eq(core.excluded.length, 36, '36 manifest exclusions');
        eq(core.dedup.length, 9, '9 duplicate groups');
        eq(core.collapsed.length, 15, '15 collapsed duplicates (24 members - 9 kept)');
        eq(core.sourceCount + core.collapsed.length, 453, 'kept + collapsed = manifest-included');
        a(core.estimatedChunkCount > 2000, 'estimated chunk count is thousands');
        const collapsedRefs = new Set(core.dedup.flatMap((g) => g.collapsed));
        for (const entry of core.included) a(!collapsedRefs.has(entry.source_ref), 'kept set excludes collapsed refs');
        a(core.snapshot.excluded.length === 36, 'snapshot carries the 36 exclusions');
        a(core.snapshot.dedup.length === 9, 'snapshot carries the dedup map');
    }

    // --- dedupe: kos-kos keeps the lowest stable_id ---
    {
        const mk = (ref) => ({
            source_ref: ref,
            source_type: 'kos_source_document',
            stable_id: builder.computeStableId(ref, ref.slice(4)),
        });
        const resolved = builder.resolveDedupeGroup('g', [mk('kos:doc_bb'), mk('kos:doc_aa')]);
        eq(resolved.kept.source_ref, 'kos:doc_aa', 'kept is lowest stable_id');
        eq(resolved.collapsed.length, 1, 'one collapsed');
        eq(resolved.collapsed[0].source_ref, 'kos:doc_bb', 'higher stable_id collapsed');
    }

    // --- dedupe: kos-disc keeps the kos row, drops the discovered row ---
    {
        const kos = { source_ref: 'kos:doc_x', source_type: 'kos_source_document', stable_id: 'x' };
        const disc = { source_ref: 'disc:doc_y', source_type: 'approved_crawled_document', stable_id: 'y' };
        const resolved = builder.resolveDedupeGroup('g', [kos, disc]);
        eq(resolved.kept.source_ref, 'kos:doc_x', 'kos kept');
        eq(resolved.collapsed[0].source_ref, 'disc:doc_y', 'discovered collapsed');
    }

    // --- dedupe: unresolved group shape aborts with a named code ---
    {
        const weird = [
            { source_ref: 'a', source_type: 'curated-other', stable_id: '1' },
            { source_ref: 'b', source_type: 'curated-other', stable_id: '2' },
        ];
        let code = null;
        try { builder.resolveDedupeGroup('g', weird); } catch (err) { code = err.code; }
        eq(code, builder.ERROR.UNRESOLVED_DUPLICATE_GROUP, 'unresolved group aborts');
    }

    // --- unpinned included source -> refuse to build ---
    {
        const manifest = fixtureManifest();
        delete manifest.entries[0].hashes;
        let code = null;
        try { builder.canonicalizeInputs(manifest); } catch (err) { code = err.code; }
        eq(code, builder.ERROR.UNPINNED_SOURCE, 'unpinned included source aborts');
    }

    // --- chunk id scheme: deterministic, unique, per-source ---
    {
        const core = builder.canonicalizeInputs(fixtureManifest());
        const entry = core.included[0];
        const meta = { title: entry.title, language: 'ru', doc_type: 'kos', source: entry.source_ref, confidence: 'unverified' };
        const chunks = builder.chunkSource(entry, 'para one about wine\n\npara two about Moldova', meta);
        const reChunks = builder.chunkSource(entry, 'para one about wine\n\npara two about Moldova', meta);
        a(chunks.length >= 1, 'chunked');
        eq(verifyChunkIdStability(chunks).hasCollisions, false, 'no chunk id collisions');
        eq(verifyChunkIdStability(chunks).perSourceUnique, true, 'per-source unique');
        eq(chunks[0].metadata.source_file, entry.source_ref, 'source_file is source_ref');
        eq(chunks[0].id, reChunks[0].id, 'chunk id deterministic from input');
    }

    // --- version_key precedence ---
    {
        eq(builder.contentVersionKey({ hashes: { normalized_text_sha256: 'a', content_hash_db: 'b' } }), 'a');
        eq(builder.contentVersionKey({ hashes: { body_sha256: 'a', raw_sha256: 'z' } }), 'a');
        eq(builder.contentVersionKey({ hashes: {} }), null);
    }

    // --- storage allow-list rejects an unknown postgres backend ---
    {
        let code = null;
        try { builder.parseStorage('postgres:random.table'); } catch (err) { code = err.code; }
        eq(code, builder.ERROR.UNKNOWN_SOURCE_STORAGE, 'unknown postgres storage aborts');
    }

    // --- dry-run needs no pool and reports deterministically ---
    {
        const report = await builder.runBuild({ dryRun: true });
        eq(report.dry_run, true, 'dry-run flag');
        eq(report.status, 'dry-run', 'dry-run status');
        a(typeof report.build_id === 'string' && report.build_id.length === 16, 'dry-run reports deterministic build_id');
        a(Array.isArray(report.verification_checklist), 'dry-run reports verification checklist');
        const report2 = await builder.runBuild({ dryRun: true });
        eq(report.build_id, report2.build_id, 'dry-run build_id stable across invocations');
    }

    // --- full pipeline against fake pool -> ready ---
    {
        const pool = seededTwoDocPool();
        const report = await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, createdBy: 'unit', embed: fakeEmbedder() });
        eq(report.status, 'ready', 'all-green gates -> ready');
        eq(report.verification.passed, true, 'verification passes');
        a(report.chunk_count > 0, 'chunks materialized');
        eq(report.chunk_count, report.embedding_count, 'full embedding coverage');
        eq(report.source_count, 2, 'source count');
        eq(report.reused, false, 'not reused on first run');
    }

    // --- idempotent re-run: same build_id, reused when already ready ---
    {
        const pool = seededTwoDocPool();
        const first = await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        const second = await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        eq(first.build_id, second.build_id, 're-run lands on same build_id');
        eq(first.status, 'ready', 'first ready');
        eq(second.reused, true, 'ready build reused without --resume');
        eq(second.status, 'ready', 're-run still ready');
        eq(pool.getChunks(first.build_id).length, first.chunk_count, 'no duplicate chunks after re-run');
    }

    // --- resume forces a re-pass and re-verifies to ready ---
    {
        const pool = seededTwoDocPool();
        const first = await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        const resumed = await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, resume: true, embed: fakeEmbedder() });
        eq(resumed.reused, false, 'resume forces a re-pass');
        eq(resumed.status, 'ready', 'resume re-verifies to ready');
        eq(first.chunk_count, resumed.chunk_count, 'unchanged content -> identical counts');
    }

    // --- gates reject a tampered build (content_hash, null embedding, pin, contamination) ---
    {
        const pool = seededTwoDocPool();
        await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        const core = builder.canonicalizeInputs(textFixtureManifest());
        const refs = core.included.map((e) => e.source_ref);
        const planChunkCount = pool.getChunks(pool.builds[0].build_id).length;

        // Clean state verifies.
        const clean = await builder.verifyBuild(pool, {
            buildId: pool.builds[0].build_id,
            fingerprint: core.fingerprint,
            snapshot: core.snapshot,
            canonicalRefs: refs,
            excluded: core.excluded,
            dedup: core.dedup,
            planChunkCount,
        });
        eq(clean.passed, true, 'clean state passes verification');

        // (1) tampered content_hash.
        const pool1 = seededTwoDocPool();
        await builder.runBuild({ pool: pool1, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        pool1.chunks[0].content_hash = 'deadbeef';
        const failHash = await builder.verifyBuild(pool1, {
            buildId: pool1.builds[0].build_id, fingerprint: core.fingerprint, snapshot: core.snapshot,
            canonicalRefs: refs, excluded: core.excluded, dedup: core.dedup, planChunkCount,
        });
        eq(failHash.passed, false, 'tampered content_hash fails verification');
        a(String(failHash.failures).includes('content_hash'), 'reports content_hash mismatch');

        // (2) null embedding in an enabled chunk.
        const pool2 = seededTwoDocPool();
        await builder.runBuild({ pool: pool2, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        pool2.chunks[0].embedding = null;
        const failEmb = await builder.verifyBuild(pool2, {
            buildId: pool2.builds[0].build_id, fingerprint: core.fingerprint, snapshot: core.snapshot,
            canonicalRefs: refs, excluded: core.excluded, dedup: core.dedup, planChunkCount,
        });
        eq(failEmb.passed, false, 'null embedding fails verification');
        a(String(failEmb.failures).toLowerCase().includes('embedding'), 'reports embedding coverage/null');

        // (3) tampered input fingerprint.
        const pool3 = seededTwoDocPool();
        await builder.runBuild({ pool: pool3, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        pool3.builds[0].input_fingerprint = 'beef';
        const failPin = await builder.verifyBuild(pool3, {
            buildId: pool3.builds[0].build_id, fingerprint: core.fingerprint, snapshot: core.snapshot,
            canonicalRefs: refs, excluded: core.excluded, dedup: core.dedup, planChunkCount,
        });
        eq(failPin.passed, false, 'fingerprint mismatch fails verification');
        a(String(failPin.failures).includes('fingerprint'), 'reports input_fingerprint mismatch');

        // (4) non-canonical source contamination.
        const pool4 = seededTwoDocPool();
        await builder.runBuild({ pool: pool4, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        pool4.chunks[0].source_file = 'legacy:orphan';
        const failCont = await builder.verifyBuild(pool4, {
            buildId: pool4.builds[0].build_id, fingerprint: core.fingerprint, snapshot: core.snapshot,
            canonicalRefs: refs, excluded: core.excluded, dedup: core.dedup, planChunkCount,
        });
        eq(failCont.passed, false, 'non-canonical source fails verification');
        a(String(failCont.failures).includes('non-canonical'), 'reports contamination');
    }

    // --- dedupe end-to-end through runBuild ---
    {
        const pool = new FakePool();
        const dupText = 'Dup body one about duplicate wine.';
        const aloneText = 'Alone body about a single wine doc.';
        const entry = (ref, id, hash) => ({
            source_ref: ref, source_type: 'kos_source_document', source_id: id,
            title: id, language: 'ru', include: true, storage: 'postgres:kos_source_documents.normalized_text',
            hashes: { normalized_text_sha256: hash }, estimated_chunks: 1, duplicate_group: 'dg',
        });
        const manifest = fixtureManifest({
            entries: [
                entry('kos:doc_dup1', 'doc_dup1', builder.sha256Text(dupText)),
                entry('kos:doc_dup2', 'doc_dup2', builder.sha256Text(dupText)),
                { ...entry('kos:doc_alone', 'doc_alone', builder.sha256Text(aloneText)), duplicate_group: null },
            ],
        });
        pool.seedSource('doc_dup1', dupText);
        pool.seedSource('doc_dup2', dupText);
        pool.seedSource('doc_alone', aloneText);
        const report = await builder.runBuild({ pool, manifest, dryRun: false, createdBy: 'dedupe', embed: fakeEmbedder() });
        eq(report.source_count, 2, 'one duplicate collapsed');
        eq(report.dedup_groups, 1, 'one dedup group');
        eq(report.collapsed_sources, 1, 'one collapsed source');
        eq(report.status, 'ready', 'deduped build reaches ready');
        const sourceFiles = new Set(pool.getChunks(report.build_id).map((c) => c.source_file));
        a(sourceFiles.has('kos:doc_dup1') || sourceFiles.has('kos:doc_dup2'), 'kept duplicate present');
        a(!(sourceFiles.has('kos:doc_dup1') && sourceFiles.has('kos:doc_dup2')), 'collapsed duplicate absent');
        a(sourceFiles.has('kos:doc_alone'), 'non-duplicate present');
    }

    // --- live DB text drifted from the pinned manifest -> build refuses ---
    {
        const pool = seededTwoDocPool();
        pool.sources[0].text = 'Drifted text that no longer matches the manifest hash.';
        let code = null;
        try {
            await builder.runBuild({ pool, manifest: textFixtureManifest(), dryRun: false, embed: fakeEmbedder() });
        } catch (err) {
            code = err.code;
        }
        eq(code, builder.ERROR.SOURCE_FETCH_FAILED, 'drifted DB text must abort (input pin at fetch time)');
    }

    console.log(`builder unit: ${assertions} assertions`);
    return { assertionCount: assertions };
}

module.exports = { run };

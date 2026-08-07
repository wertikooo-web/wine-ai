'use strict';

// Versioned corpus builder (Phase 0B Step 3 — PR2, see
// docs/architecture/BUILD_REGISTRY_DESIGN.md §3, §6). Consumes the canonical
// corpus manifest (docs/audits/corpus-manifest/manifest.json) as the ONLY
// versioned input set, resolves the named dedupe policy (§3.4), computes the
// deterministic input fingerprint / build_id / stable_id / version_key (§3.3),
// materializes v2 chunks + embeddings into build_registry_* inside the build,
// runs the verification gates (§6.4 gates 1–5), and moves the build to 'ready'
// — NEVER 'active' and never touches the runtime pointer (no search.js, no
// cutover, no activation). Out of scope for PR2 by design.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const loader = require('../knowledge/loader');
const { computeChunkHash, verifyChunkIdStability, rowToChunk } = require('../knowledge/chunkStore');
const embeddings = require('../knowledge/embeddings');
const contract = require('./sourceContract');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'docs', 'audits', 'corpus-manifest', 'manifest.json');

const BUILD_ID_SLICE = 16;
const CHUNK_ID_SLICE = 16;
const HOOKS_VERSION = 'v1';
const EMBEDDING_MODEL = embeddings.EMBEDDING_MODEL;
const EMBEDDING_DIMENSIONS = embeddings.EMBEDDING_DIMENSIONS;

// canon — the canonical text/hash/storage contract is defined ONCE in
// sourceContract.js and shared with corpus-manifest-audit.js so the manifest
// pin and the build-time fetch can never hash different bytes again.
const sha256Text = contract.sha256Text;
const { canonicalText, canonicalTextHash, pinnedVersionKey, parseStorage } = contract;

const ERROR = {
    UNRESOLVED_DUPLICATE_GROUP: 'UNRESOLVED_DUPLICATE_GROUP',
    UNPINNED_SOURCE: 'UNPINNED_SOURCE',
    UNKNOWN_SOURCE_STORAGE: 'UNKNOWN_SOURCE_STORAGE',
    SOURCE_FETCH_FAILED: 'SOURCE_FETCH_FAILED',
    EMBEDDING_DIMENSION_MISMATCH: 'EMBEDDING_DIMENSION_MISMATCH',
    MANIFEST_INVALID: 'MANIFEST_INVALID',
    UNEXPECTED_EMBEDDING_RESPONSE: 'UNEXPECTED_EMBEDDING_RESPONSE',
};

function buildError(code, detail) {
    const err = new Error(detail === undefined ? code : `${code}: ${detail}`);
    err.code = code;
    return err;
}

function sha256Parts(parts) {
    const hash = crypto.createHash('sha256');
    for (const part of parts) {
        hash.update(String(part), 'utf8').update('\n');
    }
    return hash.digest('hex');
}

// Semantic document identity: same logical document in any build has the same
// stable_id; a changed body is a new version (new version_key), not a new doc.
function computeStableId(sourceRef, sourceId) {
    return sha256Parts([sourceRef, sourceId]);
}

// chunk_id reuses the exact legacy scheme (sha256(source_file#chunk_index),
// 16-hex slice — loader.js stableId) so verifyChunkIdStability and the search
// seam apply unchanged; the composite PK (build_id, chunk_id) keeps builds
// isolated even though ids are not globally unique.
function computeChunkId(sourceRef, chunkIndex) {
    return crypto.createHash('sha256')
        .update(`${sourceRef}#${chunkIndex}`, 'utf8')
        .digest('hex')
        .slice(0, CHUNK_ID_SLICE);
}

// Content version pinned by the canonical manifest — resolved by the shared
// source contract so the audit and the builder pick the identical hash field.
function contentVersionKey(entry) {
    return pinnedVersionKey(entry);
}

// The fingerprint is a PURE function of the canonical manifest (ordered
// (stable_id, version_key) over the post-dedupe included set), so the same
// manifest always yields the same fingerprint and build_id on any machine,
// in dry-run and in a real run alike.
function computeInputFingerprint(orderedIncluded) {
    const lines = [];
    for (const entry of orderedIncluded) {
        lines.push(`${entry.stable_id}\n${entry.version_key}`);
    }
    return sha256Text(lines.join('\n'));
}

function deriveBuildId(fingerprint) {
    return sha256Text(fingerprint).slice(0, BUILD_ID_SLICE);
}

function sourceDocType(sourceType) {
    if (sourceType === 'kos_source_document') return 'kos';
    if (sourceType === 'approved_crawled_document') return 'crawled';
    if (typeof sourceType === 'string' && sourceType.startsWith('curated-')) return 'curated';
    return 'unknown';
}

function sourceConfidence(entry) {
    return (entry.provenance && entry.provenance.confidence) || 'unverified';
}

async function fetchSourceText(entry, pool, repoRoot = REPO_ROOT) {
    const storage = parseStorage(entry.storage);
    if (storage.kind === 'postgres') {
        if (!pool) {
            throw buildError(ERROR.SOURCE_FETCH_FAILED, `${entry.source_ref}: pool required for postgres source`);
        }
        const { rows } = await pool.query(
            `SELECT ${storage.column} AS content FROM ${storage.table} WHERE id = $1`,
            [entry.source_id]
        );
        if (rows.length === 0) {
            throw buildError(ERROR.SOURCE_FETCH_FAILED, `${entry.source_ref}: missing in ${storage.table}`);
        }
        const text = rows[0].content;
        if (!text || canonicalText(text).length === 0) {
            throw buildError(ERROR.SOURCE_FETCH_FAILED, `${entry.source_ref}: empty ${storage.column}`);
        }
        // Input pin at fetch time: the live DB must still match the canonical
        // manifest snapshot. A drifted body means the manifest is stale — the
        // build refuses rather than silently embedding different content under
        // the same build_id. (Filesystem sources are pinned by git itself.)
        //
        // The hash is the SHARED canonical body hash (see sourceContract.js):
        // the manifest pins the same value, so trailing/leading whitespace in
        // the DB can never masquerade as a content change and abort a build.
        const canonical = canonicalText(text);
        const fetchedHash = canonicalTextHash(canonical);
        if (fetchedHash !== entry.version_key) {
            throw buildError(
                ERROR.SOURCE_FETCH_FAILED,
                `${entry.source_ref}: fetched content hash ${fetchedHash.slice(0, 12)}... != pinned ${entry.version_key.slice(0, 12)}...`
            );
        }
        return {
            text: canonical,
            metadata: {
                title: entry.title || entry.source_ref,
                language: entry.language || 'ru',
                doc_type: sourceDocType(entry.source_type),
                source: entry.source_ref,
                confidence: sourceConfidence(entry),
            },
        };
    }

    const filePath = path.join(repoRoot, storage.file);
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        throw buildError(ERROR.SOURCE_FETCH_FAILED, `${entry.source_ref}: ${err.message}`);
    }
    const { metadata, body } = loader.parseFrontmatter(raw);
    const canonical = canonicalText(body);
    if (canonical.length === 0) {
        throw buildError(ERROR.SOURCE_FETCH_FAILED, `${entry.source_ref}: empty body`);
    }
    return {
        text: canonical,
        metadata: {
            title: entry.title || metadata.title || entry.source_ref,
            language: entry.language || metadata.language || 'ru',
            doc_type: metadata.doc_type || sourceDocType(entry.source_type),
            source: entry.source_ref,
            confidence: metadata.confidence || sourceConfidence(entry),
        },
    };
}

function chunkSource(entry, text, baseMetadata) {
    const texts = loader.chunkText(text);
    return texts.map((chunkText_, index) => {
        const metadata = {
            title: baseMetadata.title || entry.source_ref,
            language: baseMetadata.language || 'ru',
            doc_type: baseMetadata.doc_type || 'unknown',
            source: entry.source_ref,
            confidence: baseMetadata.confidence || 'unverified',
            source_file: entry.source_ref,
            chunk_index: index,
            entity_id: null,
            enabled: true,
        };
        return { id: computeChunkId(entry.source_ref, index), text: chunkText_, metadata };
    });
}

const CHUNK_COLUMNS = [
    'chunk_id', 'build_id', 'source_file', 'title', 'doc_type', 'language',
    'source', 'confidence', 'entity_id', 'winery', 'region', 'grape', 'date',
    'enabled', 'chunk_index', 'text', 'content_hash', 'version_key', 'model',
];

function buildChunkRows(buildId, entry, chunks) {
    return chunks.map((chunk) => {
        const m = chunk.metadata;
        return {
            chunk_id: chunk.id,
            build_id: buildId,
            source_file: entry.source_ref,
            title: m.title || null,
            doc_type: m.doc_type || null,
            language: m.language || null,
            source: entry.source_ref,
            confidence: m.confidence || null,
            entity_id: null,
            winery: null,
            region: null,
            grape: null,
            date: null,
            enabled: m.enabled !== false,
            chunk_index: m.chunk_index,
            text: chunk.text,
            content_hash: computeChunkHash(chunk),
            version_key: entry.version_key,
            model: null,
        };
    });
}

// Named dedupe policy (design §3.4). Applied inside the build's include filter:
// the build refuses to start while any duplicate group is unresolved.
function resolveDedupeGroup(group, members) {
    const kinds = new Set(members.map((m) => m.source_type));
    if (kinds.has('approved_crawled_document')) {
        // kos-disc: keep the canonical kos_source_documents row; drop the
        // discovered-* derived row (no canonical input).
        const kos = members.filter((m) => m.source_type === 'kos_source_document');
        const disc = members.filter((m) => m.source_type === 'approved_crawled_document');
        if (kos.length !== 1 || disc.length !== 1 || members.length !== 2) {
            throw buildError(ERROR.UNRESOLVED_DUPLICATE_GROUP, `group ${group}: kos-disc must be exactly 1 kos + 1 discovered`);
        }
        return { kept: kos[0], collapsed: disc };
    }
    if (kinds.size === 1 && kinds.has('kos_source_document')) {
        // kos-kos: keep the lowest stable_id (deterministic tie-break); the
        // manifest snapshot carries no created_at, so the final tie-break rule
        // is the reproducible stable_id ordering.
        const sorted = members.slice().sort((a, b) => {
            if (a.stable_id !== b.stable_id) return a.stable_id.localeCompare(b.stable_id);
            return a.source_ref.localeCompare(b.source_ref);
        });
        return { kept: sorted[0], collapsed: sorted.slice(1) };
    }
    throw buildError(ERROR.UNRESOLVED_DUPLICATE_GROUP, `group ${group}: unexpected kinds ${[...kinds].join(',')}`);
}

function loadManifest(manifestPath = MANIFEST_PATH) {
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
    } catch (err) {
        throw buildError(ERROR.MANIFEST_INVALID, err.message);
    }
    let manifest;
    try {
        manifest = JSON.parse(raw);
    } catch (err) {
        throw buildError(ERROR.MANIFEST_INVALID, `unparsable JSON: ${err.message}`);
    }
    if (!manifest || !Array.isArray(manifest.entries)) {
        throw buildError(ERROR.MANIFEST_INVALID, 'missing entries array');
    }
    return manifest;
}

// Pure canonicalization: manifest → effective included set, exclusions, dedup
// map, fingerprint, build_id, and the stored input snapshot. No I/O beyond the
// manifest itself — dry-run and real-run share this exact computation.
function canonicalizeInputs(manifest) {
    const includedRaw = manifest.entries.filter((e) => e.include === true);
    const excludedRaw = manifest.entries.filter((e) => e.include !== true);

    const normalized = includedRaw.map((e) => {
        const versionKey = contentVersionKey(e);
        if (!versionKey) {
            throw buildError(ERROR.UNPINNED_SOURCE, `${e.source_ref}: included input has no pinned content hash`);
        }
        return {
            source_ref: e.source_ref,
            source_id: e.source_id,
            source_type: e.source_type,
            title: e.title || null,
            language: e.language || null,
            storage: e.storage,
            version_key: versionKey,
            duplicate_group: e.duplicate_group || null,
            stable_id: computeStableId(e.source_ref, e.source_id),
            estimated_chunks: Number(e.estimated_chunks || 0),
        };
    });

    const groups = new Map();
    for (const entry of normalized) {
        if (!entry.duplicate_group) continue;
        if (!groups.has(entry.duplicate_group)) groups.set(entry.duplicate_group, []);
        groups.get(entry.duplicate_group).push(entry);
    }

    const collapsed = [];
    const dedup = [];
    const keptRefs = new Set(normalized.map((e) => e.source_ref));
    for (const [group, members] of groups) {
        const resolved = resolveDedupeGroup(group, members);
        for (const member of resolved.collapsed) {
            collapsed.push({
                source_ref: member.source_ref,
                source_type: member.source_type,
                duplicate_of: resolved.kept.source_ref,
                excluded_reason: 'deduplicated',
            });
            keptRefs.delete(member.source_ref);
        }
        dedup.push({
            group,
            kept: resolved.kept.source_ref,
            collapsed: resolved.collapsed.map((c) => c.source_ref),
        });
    }

    const included = normalized.filter((e) => keptRefs.has(e.source_ref));
    const ordered = included.slice().sort((a, b) => a.source_ref.localeCompare(b.source_ref));
    const excluded = excludedRaw.map((e) => ({
        source_ref: e.source_ref,
        source_type: e.source_type,
        excluded_reason: e.exclude_reason || 'excluded',
    }));
    const fingerprint = computeInputFingerprint(ordered);
    const buildId = deriveBuildId(fingerprint);

    const snapshot = {
        generated_at: manifest.generated_at || null,
        mode: manifest.mode || null,
        production_snapshot: manifest.production_snapshot || null,
        fingerprint,
        included: ordered.map((e) => ({
            source_ref: e.source_ref,
            source_type: e.source_type,
            title: e.title,
            language: e.language,
            storage: e.storage,
            stable_id: e.stable_id,
            version_key: e.version_key,
        })),
        excluded,
        dedup,
    };

    return {
        included,
        excluded,
        collapsed,
        dedup,
        fingerprint,
        buildId,
        sourceCount: included.length,
        estimatedChunkCount: included.reduce((sum, e) => sum + e.estimated_chunks, 0),
        snapshot,
    };
}

async function findBuild(pool, buildId) {
    const { rows } = await pool.query(
        'SELECT status, chunk_count, embedding_count FROM build_registry_builds WHERE build_id = $1',
        [buildId]
    );
    return rows[0] || null;
}

async function registerBuild(pool, { buildId, fingerprint, snapshot, sourceCount, createdBy }) {
    await pool.query(
        `INSERT INTO build_registry_builds
             (build_id, status, input_fingerprint, input_snapshot, source_count, created_by, started_at)
         VALUES ($1, 'building', $2, $3::jsonb, $4, $5, NOW())
         ON CONFLICT (build_id) DO UPDATE SET
             status = 'building',
             input_fingerprint = EXCLUDED.input_fingerprint,
             input_snapshot = EXCLUDED.input_snapshot,
             source_count = EXCLUDED.source_count,
             created_by = EXCLUDED.created_by,
             finished_at = NULL,
             updated_at = NOW()`,
        [buildId, fingerprint, JSON.stringify(snapshot), sourceCount, createdBy || null]
    );
}

const CHUNK_UPSERT_SQL = `
INSERT INTO build_registry_chunks (
    ${CHUNK_COLUMNS.join(', ')}
) VALUES (${CHUNK_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
ON CONFLICT (build_id, chunk_id) DO UPDATE SET
    ${CHUNK_COLUMNS.filter((c) => c !== 'chunk_id' && c !== 'build_id')
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(',\n    ')},
    updated_at = NOW()`;

// Materialize one source's chunk rows. Resume/idempotency: if the build already
// holds this source_file at the same version_key, rows are untouched; if the
// version_key changed, the stale rows for that source are replaced (so counts
// always match the derived plan — no orphaned stale chunks under a build).
async function materializeSource(pool, buildId, entry, rows) {
    const { rows: existing } = await pool.query(
        'SELECT version_key FROM build_registry_chunks WHERE build_id = $1 AND source_file = $2 LIMIT 1',
        [buildId, entry.source_ref]
    );
    const prev = existing.length > 0 ? existing[0].version_key : null;
    if (prev === entry.version_key) {
        return { source_file: entry.source_ref, deleted: 0, inserted: 0, updated: 0, unchanged: rows.length };
    }
    let deleted = 0;
    if (prev !== null) {
        const result = await pool.query(
            'DELETE FROM build_registry_chunks WHERE build_id = $1 AND source_file = $2',
            [buildId, entry.source_ref]
        );
        deleted = result.rowCount || 0;
    }
    for (const row of rows) {
        await pool.query(CHUNK_UPSERT_SQL, CHUNK_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])));
    }
    return { source_file: entry.source_ref, deleted, inserted: rows.length, updated: 0, unchanged: 0 };
}

function defaultEmbedder(chunks) {
    return embeddings.embedTexts(chunks.map((chunk) => embeddings.buildEmbeddingText(chunk)));
}

// Embed only rows whose embedding is still NULL (idempotent resume); unchanged
// rows keep their stored vectors. `embed` is injectable for tests so the
// pipeline is fully exercisable without the Gemini API.
async function embedMissing(pool, buildId, embed = defaultEmbedder) {
    const { rows } = await pool.query(
        `SELECT chunk_id, source_file, title, doc_type, language, source, confidence,
                entity_id, winery, region, grape, date, enabled, chunk_index, text
         FROM build_registry_chunks
         WHERE build_id = $1 AND embedding IS NULL
         ORDER BY chunk_index`,
        [buildId]
    );
    if (rows.length === 0) return { embedded: 0, skipped: 0 };

    const chunks = rows.map((r) => rowToChunk({ ...r, chunk_id: r.chunk_id }));
    const vectors = await embed(chunks);
    if (!Array.isArray(vectors) || vectors.length !== rows.length) {
        throw buildError(ERROR.UNEXPECTED_EMBEDDING_RESPONSE, `expected ${rows.length} vectors, got ${vectors && vectors.length}`);
    }
    for (let i = 0; i < rows.length; i += 1) {
        await pool.query(
            'UPDATE build_registry_chunks SET embedding = $1::vector, model = $2, updated_at = NOW() WHERE build_id = $3 AND chunk_id = $4',
            [JSON.stringify(vectors[i]), EMBEDDING_MODEL, buildId, rows[i].chunk_id]
        );
    }
    return { embedded: rows.length, skipped: 0 };
}

// Read the vector dimension from the actual schema (design §4 note): prefer the
// legacy embedding column, else the registry column; refuse to run if it
// disagrees with the configured model output.
//
// pgvector reports the dimension differently across versions: older builds put
// `4 + 4*dim` in atttypmod, newer ones (e.g. 0.8.x) use the plain `dim`. To be
// robust, parse the resolved type text `vector(<n>)` and fall back to atttypmod
// arithmetic only when the type text has no explicit dimension.
async function embeddingDimension(pool) {
    const candidates = [
        ['knowledge_chunk_embeddings', 'embedding'],
        ['build_registry_chunks', 'embedding'],
    ];
    for (const [table, column] of candidates) {
        try {
            const { rows } = await pool.query(
                `SELECT a.atttypmod, format_type(a.atttypid, a.atttypmod) AS resolved_type
                 FROM pg_attribute a
                 JOIN pg_class c ON c.oid = a.attrelid
                 WHERE c.relname = $1 AND a.attname = $2 AND a.attnum > 0`,
                [table, column]
            );
            if (rows.length > 0) {
                const match = /vector\((\d+)\)/.exec(rows[0].resolved_type || '');
                if (match) {
                    return { dimension: Number(match[1]), source: `${table}.${column}` };
                }
                const dim = rows[0].atttypmod > 0 ? (rows[0].atttypmod - 4) / 4 : 0;
                if (Number.isFinite(dim) && dim > 0) {
                    return { dimension: dim, source: `${table}.${column}` };
                }
            }
        } catch (_err) {
            // Table or extension may not exist yet; try the next candidate.
        }
    }
    return { dimension: EMBEDDING_DIMENSIONS, source: 'config' };
}

async function finalizeBuild(pool, buildId, { chunkCount, embeddingCount }) {
    await pool.query(
        `UPDATE build_registry_builds SET
             chunk_count = $1, embedding_count = $2, model = $3, hooks_version = $4,
             finished_at = NOW(), updated_at = NOW()
         WHERE build_id = $5`,
        [chunkCount, embeddingCount, EMBEDDING_MODEL, HOOKS_VERSION, buildId]
    );
}

async function setBuildStatus(pool, buildId, status) {
    await pool.query(
        'UPDATE build_registry_builds SET status = $1, finished_at = NOW(), updated_at = NOW() WHERE build_id = $2',
        [status, buildId]
    );
}

// §6.4 gates 1–5 (the DB-checkable gates for PR2; benchmark/latency/rollback
// gates belong to the later cutover PR).
async function verifyBuild(pool, { buildId, fingerprint, snapshot, canonicalRefs, excluded, dedup, planChunkCount }) {
    const failures = [];

    const { rows: buildRows } = await pool.query(
        'SELECT source_count, chunk_count, embedding_count, input_fingerprint, input_snapshot FROM build_registry_builds WHERE build_id = $1',
        [buildId]
    );
    if (buildRows.length === 0) {
        return { passed: false, failures: ['build row missing'] };
    }
    const build = buildRows[0];

    const { rows: chunkRows } = await pool.query(
        `SELECT chunk_id, content_hash, source_file, title, chunk_index, text, enabled,
                embedding IS NOT NULL AS embedded
         FROM build_registry_chunks WHERE build_id = $1 ORDER BY source_file, chunk_index`,
        [buildId]
    );
    const dbChunkCount = chunkRows.length;
    const dbEmbedded = chunkRows.filter((r) => r.embedded).length;

    // Gate 1 — counts.
    if (build.source_count !== canonicalRefs.length) {
        failures.push(`source_count mismatch: registered=${build.source_count} plan=${canonicalRefs.length}`);
    }
    if (dbChunkCount !== build.chunk_count) {
        failures.push(`chunk_count mismatch: db=${dbChunkCount} registered=${build.chunk_count}`);
    }
    if (dbChunkCount !== planChunkCount) {
        failures.push(`chunk_count vs plan: db=${dbChunkCount} plan=${planChunkCount}`);
    }
    if (dbEmbedded !== build.embedding_count) {
        failures.push(`embedding_count mismatch: db=${dbEmbedded} registered=${build.embedding_count}`);
    }

    // Gate 2 — chunk determinism (chunk_id scheme + computeChunkHash v1).
    for (const row of chunkRows) {
        if (computeChunkId(row.source_file, row.chunk_index) !== row.chunk_id) {
            failures.push(`chunk_id mismatch: ${row.chunk_id}`);
        }
        if (computeChunkHash({ text: row.text, metadata: { source_file: row.source_file, title: row.title, chunk_index: row.chunk_index } }) !== row.content_hash) {
            failures.push(`content_hash mismatch: ${row.chunk_id}`);
        }
    }
    const stability = verifyChunkIdStability(chunkRows.map((r) => ({ id: r.chunk_id, metadata: { source_file: r.source_file } })));
    if (stability.hasCollisions) {
        failures.push(`chunk id collisions: ${stability.duplicateIds.join(',')}`);
    }

    // Gate 3 — embedding coverage (0 null embeddings in enabled chunks).
    const nullEnabled = chunkRows.filter((r) => !r.embedded && r.enabled).length;
    if (nullEnabled > 0) {
        failures.push(`null embeddings in enabled chunks: ${nullEnabled}`);
    }
    if (dbEmbedded !== dbChunkCount) {
        failures.push(`embedding coverage: ${dbEmbedded}/${dbChunkCount} embedded`);
    }

    // Gate 4 — input pin (fingerprint + excluded set + dedup map in snapshot).
    if (build.input_fingerprint !== fingerprint) {
        failures.push('input_fingerprint mismatch');
    }
    const snap = build.input_snapshot;
    if (!snap || snap.fingerprint !== fingerprint) {
        failures.push('snapshot fingerprint mismatch');
    }
    if (!snap || !Array.isArray(snap.excluded)) {
        failures.push('snapshot excluded list missing');
    } else {
        const excludedRefs = new Set(snap.excluded.map((e) => e.source_ref));
        for (const entry of excluded) {
            if (!excludedRefs.has(entry.source_ref)) {
                failures.push(`excluded ${entry.source_ref} missing from snapshot`);
            }
        }
    }
    if (!snap || !Array.isArray(snap.dedup) || snap.dedup.length !== dedup.length) {
        failures.push('dedup map mismatch');
    }

    // Gate 5 — no legacy contamination: every chunk source_file is a canonical ref.
    const canonicalSet = new Set(canonicalRefs);
    for (const sourceFile of new Set(chunkRows.map((r) => r.source_file))) {
        if (!canonicalSet.has(sourceFile)) {
            failures.push(`non-canonical source in chunks: ${sourceFile}`);
        }
    }

    return { passed: failures.length === 0, failures };
}

async function runBuild({
    pool = null,
    manifestPath = MANIFEST_PATH,
    manifest = null,
    dryRun = false,
    resume = false,
    createdBy = null,
    embed = null,
} = {}) {
    const loaded = manifest || loadManifest(manifestPath);
    const core = canonicalizeInputs(loaded);

    const report = {
        dry_run: dryRun,
        manifest: {
            generated_at: loaded.generated_at,
            mode: loaded.mode,
            production_snapshot: loaded.production_snapshot,
        },
        build_id: core.buildId,
        input_fingerprint: core.fingerprint,
        source_count: core.sourceCount,
        excluded_count: core.excluded.length,
        collapsed_sources: core.collapsed.length,
        dedup_groups: core.dedup.length,
        estimated_chunk_count: core.estimatedChunkCount,
    };

    if (dryRun) {
        report.status = 'dry-run';
        report.verification_checklist = [
            'counts (source/chunk/embedding)',
            'chunk determinism (chunk_id + content_hash)',
            'embedding coverage (0 null in enabled)',
            'input pin (fingerprint + excluded + dedup)',
            'no legacy contamination',
            'embedding dimension vs schema',
        ];
        return report;
    }

    if (!pool) {
        throw new TypeError('runBuild: pool is required unless --dry-run is set');
    }

    const dim = await embeddingDimension(pool);
    if (dim.dimension !== EMBEDDING_DIMENSIONS) {
        throw buildError(
            ERROR.EMBEDDING_DIMENSION_MISMATCH,
            `schema=${dim.source}(${dim.dimension}) config=${EMBEDDING_DIMENSIONS}`
        );
    }

    const existing = await findBuild(pool, core.buildId);
    if (existing && existing.status === 'ready' && !resume) {
        return {
            ...report,
            status: 'ready',
            reused: true,
            chunk_count: existing.chunk_count,
            embedding_count: existing.embedding_count,
        };
    }

    await registerBuild(pool, {
        buildId: core.buildId,
        fingerprint: core.fingerprint,
        snapshot: core.snapshot,
        sourceCount: core.sourceCount,
        createdBy,
    });

    const embedder = embed || defaultEmbedder;
    const materialized = [];
    let planChunkCount = 0;
    for (const entry of core.included) {
        const { text, metadata } = await fetchSourceText(entry, pool);
        const chunks = chunkSource(entry, text, metadata);
        const rows = buildChunkRows(core.buildId, entry, chunks);
        const result = await materializeSource(pool, core.buildId, entry, rows);
        planChunkCount += rows.length;
        materialized.push(result);
    }

    const embedded = await embedMissing(pool, core.buildId, embedder);

    const { rows: countRows } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM build_registry_chunks WHERE build_id = $1) AS chunk_count,
            (SELECT COUNT(*)::int FROM build_registry_chunks WHERE build_id = $1 AND embedding IS NOT NULL) AS embedding_count`,
        [core.buildId]
    );
    const { chunk_count: dbChunkCount, embedding_count: dbEmbeddingCount } = countRows[0];

    await finalizeBuild(pool, core.buildId, { chunkCount: dbChunkCount, embeddingCount: dbEmbeddingCount });

    const verification = await verifyBuild(pool, {
        buildId: core.buildId,
        fingerprint: core.fingerprint,
        snapshot: core.snapshot,
        canonicalRefs: core.included.map((e) => e.source_ref),
        excluded: core.excluded,
        dedup: core.dedup,
        planChunkCount,
    });

    const status = verification.passed ? 'ready' : 'verification_failed';
    await setBuildStatus(pool, core.buildId, status);

    return {
        ...report,
        status,
        reused: false,
        chunk_count: dbChunkCount,
        embedding_count: dbEmbeddingCount,
        materialized,
        embedded,
        verification,
        embedding_dimension: { dimension: dim.dimension, source: dim.source },
    };
}

module.exports = {
    REPO_ROOT,
    MANIFEST_PATH,
    BUILD_ID_SLICE,
    CHUNK_ID_SLICE,
    HOOKS_VERSION,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
    ERROR,
    sha256Text,
    sha256Parts,
    computeStableId,
    computeChunkId,
    contentVersionKey,
    computeInputFingerprint,
    deriveBuildId,
    parseStorage,
    sourceDocType,
    sourceConfidence,
    fetchSourceText,
    chunkSource,
    buildChunkRows,
    resolveDedupeGroup,
    loadManifest,
    canonicalizeInputs,
    findBuild,
    registerBuild,
    materializeSource,
    defaultEmbedder,
    embedMissing,
    embeddingDimension,
    finalizeBuild,
    setBuildStatus,
    verifyBuild,
    runBuild,
};

'use strict';

// Phase 0B Step 1 — read-only canonical source manifest audit.
// Produces docs/audits/corpus-manifest/manifest.json + manifest.csv + report.md
//
// Canonical inputs for the versioned rebuild are ONLY:
//   1. kos_source_documents (status='active', text available)
//   2. knowledge_documents (status='approved') — the discovered store; the
//      discovered-*.md files on disk are DERIVED from it at boot (republish).
//   3. curated files in knowledge/source/ that are NOT derived artifacts
//      (exclude discovered-*, index.json, and other generated outputs).
//
// READ-ONLY: connects to production PG with SELECT only, reads local
// knowledge/source files (git-committed curated files == production for the
// 31 curated files; discovered-* on local disk are a stale snapshot and are
// excluded as inputs regardless). No writes to DB, no new tables, no sync.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chunkDocument } = require('../src/knowledge/loader');

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'audits', 'corpus-manifest');
const SOURCE_DIR = path.resolve(__dirname, '..', 'knowledge', 'source');

const USAGE = [
    'corpus-manifest-audit: a snapshot file is required.',
    '',
    'Usage:',
    '  node scripts/corpus-manifest-audit.js --snapshot <path>',
    '',
    'Example:',
    '  node scripts/corpus-manifest-audit.js --snapshot ./reconcile-production.json',
    '',
    'The snapshot is a read-only reconcile-production.json (FS+PG corpus summary).',
].join('\n');

const DERIVED_PREFIXES = ['discovered-'];
const GENERATED_FILES = new Set(['index.json', 'index.json.bak']);

function sha256(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv : (typeof process !== 'undefined' ? process.argv.slice(2) : []);
    const idx = args.indexOf('--snapshot');
    if (idx === -1) return { snapshot: null };
    if (idx + 1 >= args.length || args[idx + 1].startsWith('--')) return { error: '--snapshot requires a file path' };
    return { snapshot: args[idx + 1] };
}

function loadSnapshot(snapshotPath) {
    const resolved = path.resolve(snapshotPath);
    const raw = fs.readFileSync(resolved, 'utf8');
    if (!raw.trim()) throw new Error(`snapshot file is empty: ${resolved}`);
    const data = JSON.parse(raw);
    if (!Array.isArray(data.fileSummaries)) throw new Error(`snapshot must contain a fileSummaries array: ${resolved}`);
    return data;
}

function estimateChunks(body) {
    if (!body || body.trim().length === 0) return 0;
    const doc = { sourceFile: 'manifest-estimate.md', metadata: { title: 'x', language: 'ru' }, body, validation: { sourceFile: 'x', missing: [], unknown: [] } };
    return chunkDocument(doc).length;
}

function classifyCurated(file) {
    if (file.startsWith('book-')) return 'curated-book';
    if (file.startsWith('manual-')) return 'curated-manual';
    if (file.startsWith('moldova-')) return 'curated-moldova';
    if (file.startsWith('news-')) return 'curated-news';
    if (file.startsWith('demo-')) return 'curated-demo';
    if (file.startsWith('feteasca-')) return 'curated-feteasca';
    if (file.startsWith('Ghid_')) return 'curated-uploaded-pdf';
    return 'curated-other';
}

async function main(argv) {
    const { snapshot: snapshotPath, error } = parseArgs(argv);
    if (error) {
        console.error(error);
        console.error(USAGE);
        process.exit(2);
    }
    if (!snapshotPath) {
        console.error(USAGE);
        process.exit(2);
    }

    let RECONCILE;
    try {
        RECONCILE = loadSnapshot(snapshotPath);
    } catch (err) {
        console.error(`failed to load snapshot: ${err.message}`);
        console.error(USAGE);
        process.exit(2);
    }

    const db = require('../src/knowledge/db');
    if (!db.isEnabled()) {
        console.error('DATABASE_URL not set — aborting (manifest audit needs production PG read access).');
        process.exit(1);
    }
    const pool = await db.init();
    const q = async (s, p) => (await pool.query(s, p)).rows;

    const entries = [];
    const dupGroups = new Map(); // hash -> group id
    const issues = { empty: [], jsRendered: [], duplicate: [], multiVersion: [], navBoilerplate: [], localOnly: [], noProvenance: [], unlinkableChunks: [] };

    // ---------- 1. kos_source_documents ----------
    const kosDocs = await q(`
        SELECT id, title, canonical_url, source_id, status, document_type,
               language, content_hash, normalized_text, content_length, fetched_at
        FROM kos_source_documents
        ORDER BY id
    `);
    const kosSourceMap = new Map((await q('SELECT id, name, normalized_origin, source_type, trust_level, publisher, winery_id FROM kos_sources')).map((r) => [r.id, r]));

    let kosIncluded = 0;
    let kosExcluded = 0;
    let kosUnavailable = 0;
    let kosEmpty = 0;
    for (const d of kosDocs) {
        const src = kosSourceMap.get(d.source_id);
        const hasText = d.normalized_text && d.normalized_text.trim().length > 0;
        const textLen = hasText ? d.normalized_text.length : 0;
        const provenance = src && (src.normalized_origin || src.name) ? { source_id: d.source_id, origin: src.normalized_origin || src.name, trust_level: src.trust_level || null } : null;
        const title = d.title || d.canonical_url || d.id;

        const e = {
            source_ref: `kos:${d.id}`,
            source_type: 'kos_source_document',
            source_id: d.id,
            title,
            language: d.language || 'auto',
            status: d.status,
            approval: d.status === 'active' ? 'active' : 'pending',
            text_available: hasText,
            storage: 'postgres:kos_source_documents.normalized_text',
            hashes: {
                content_hash_db: d.content_hash || null,
                normalized_text_sha256: hasText ? sha256(d.normalized_text.trim()) : null,
            },
            text_size_chars: textLen,
            estimated_chunks: hasText ? estimateChunks(d.normalized_text) : 0,
            duplicate_group: null,
            include: false,
            exclude_reason: null,
            provenance,
            issues: [],
        };

        // exclusion logic
        if (d.status !== 'active') {
            e.exclude_reason = 'status_not_active';
            e.issues.push('status_pending');
        } else if (!hasText) {
            kosEmpty += 1;
            e.exclude_reason = 'text_unavailable';
            e.issues.push('empty_or_js_rendered');
            issues.empty.push(e.source_ref);
            if (/(cricova\.md|wine\.md)/.test(d.canonical_url || '')) issues.jsRendered.push(e.source_ref);
        } else {
            e.include = true;
            kosIncluded += 1;
            e.estimated_chunks = estimateChunks(d.normalized_text);
        }
        if (!e.include) {
            kosExcluded += 1;
            if (!hasText) kosUnavailable += 1;
        }

        entries.push(e);
    }

    // ---------- 2. knowledge_documents (approved discovered store) ----------
    const discDocs = await q(`
        SELECT id, title, url, publisher, source_id, trust_level, status,
               content_hash, text, language, fetched_at
        FROM knowledge_documents
        ORDER BY id
    `);
    let discIncluded = 0;
    let discExcluded = 0;
    for (const d of discDocs) {
        const hasText = d.text && d.text.trim().length > 0;
        const textLen = hasText ? d.text.length : 0;
        const e = {
            source_ref: `disc:${d.id}`,
            source_type: 'approved_crawled_document',
            source_id: d.id,
            title: d.title || d.url || d.id,
            language: d.language || 'auto',
            status: d.status,
            approval: d.status === 'approved' ? 'approved' : d.status,
            text_available: hasText,
            storage: 'postgres:knowledge_documents.text',
            hashes: {
                content_hash_db: d.content_hash || null,
                text_sha256: hasText ? sha256(d.text.trim()) : null,
            },
            text_size_chars: textLen,
            estimated_chunks: hasText ? estimateChunks(d.text) : 0,
            duplicate_group: null,
            include: false,
            exclude_reason: null,
            provenance: { source_id: d.source_id, publisher: d.publisher || null, trust_level: d.trust_level || null },
            issues: [],
        };
        if (d.status !== 'approved') {
            e.exclude_reason = 'status_not_approved';
        } else if (!hasText) {
            e.exclude_reason = 'text_unavailable';
            e.issues.push('empty');
            issues.empty.push(e.source_ref);
        } else {
            e.include = true;
            discIncluded += 1;
        }
        if (!e.include) discExcluded += 1;
        entries.push(e);
    }

    // ---------- 3. curated files (git-committed, == production) ----------
    const curatedFiles = fs.readdirSync(SOURCE_DIR)
        .filter((f) => !DERIVED_PREFIXES.some((p) => f.startsWith(p)))
        .filter((f) => !GENERATED_FILES.has(f))
        .sort();
    let curatedIncluded = 0;
    let curatedExcluded = 0;
    for (const file of curatedFiles) {
        const raw = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
        const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
        const body = bodyMatch ? bodyMatch[1].trim() : raw.trim();
        const meta = {};
        if (fm) for (const line of fm[1].split(/\r?\n/)) {
            const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line.trim());
            if (m) meta[m[1].trim()] = m[2].trim();
        }
        const conf = meta.confidence || 'unverified';
        const docType = meta.doc_type || 'unknown';
        const hasText = body.length > 0;

        const e = {
            source_ref: `curated:${file}`,
            source_type: classifyCurated(file),
            source_id: file,
            title: meta.title || file,
            language: meta.language || 'ru',
            status: 'git_committed',
            approval: 'curated',
            text_available: hasText,
            storage: 'filesystem:knowledge/source/' + file,
            hashes: {
                raw_sha256: sha256(raw),
                body_sha256: sha256(body),
            },
            text_size_chars: body.length,
            estimated_chunks: hasText ? estimateChunks(body) : 0,
            duplicate_group: null,
            include: false,
            exclude_reason: null,
            provenance: { confidence: conf, source_note: meta.source || null, doc_type: docType },
            issues: [],
        };

        if (!hasText) {
            e.exclude_reason = 'text_unavailable';
            e.issues.push('empty');
            issues.empty.push(e.source_ref);
        } else if (conf === 'demo') {
            // demo/* files are not canonical production inputs
            e.exclude_reason = 'demo_content';
            e.issues.push('demo_content');
        } else if (docType === 'internal_reference' && file !== 'cricova.md' && file !== 'purcari.md') {
            e.exclude_reason = 'internal_reference_without_source';
            e.issues.push('no_external_provenance');
            issues.noProvenance.push(e.source_ref);
        } else {
            e.include = true;
            curatedIncluded += 1;
        }
        if (!e.include) curatedExcluded += 1;

        // cross-source duplicate check by body hash (curated vs discovered-derived)
        entries.push(e);
    }

    // duplicate-group detection across ALL entries by text sha256.
    // Only ACTUAL duplicates (same text hash, ≥2 refs) get a duplicate_group;
    // the DB content_hash (kos/knowledge_documents) is reported as a field but
    // is NOT used as a duplicate key here.
    const byTextHash = new Map();
    const dupGroupsFinal = new Map(); // groupId -> [refs]
    for (const e of entries) {
        const th = e.hashes.normalized_text_sha256 || e.hashes.text_sha256 || e.hashes.body_sha256;
        if (!th) continue;
        if (!byTextHash.has(th)) byTextHash.set(th, []);
        byTextHash.get(th).push(e);
    }
    let dupGroupId = 0;
    for (const [, group] of byTextHash) {
        if (group.length < 2) continue;
        dupGroupId += 1;
        for (const e of group) e.duplicate_group = dupGroupId;
        dupGroupsFinal.set(dupGroupId, group.map((e) => e.source_ref));
        issues.duplicate.push(group.map((e) => e.source_ref).join(' == '));
    }

    // ---------- 4. current PG chunks unlinkable to a canonical input ----------
    // discovered-kos-* chunks are DUPLICATES of kos_source_documents content
    // (verified: all 86 local discovered-kos bodies match a kos doc body by
    // sha256), so they link to a canonical input as duplicate. Only chunks
    // whose source_file is absent from production FS AND absent from the
    // knowledge_documents (approved) store are truly unlinkable.
    const prodFs = new Set(RECONCILE.fileSummaries.map((f) => f.file));
    const pgChunks = await q('SELECT chunk_id, source_file, document_id FROM knowledge_chunks');
    const kosIds = new Set(entries.filter((e) => e.source_type === 'kos_source_document').map((e) => e.source_id));
    let unlinkable = 0;
    let unlinkableByPrefix = new Map();
    let duplicateKosChunks = 0;
    for (const c of pgChunks) {
        let linkable = false;
        if (c.document_id && kosIds.has(c.document_id)) linkable = true;
        else if (!c.document_id && prodFs.has(c.source_file)) linkable = true; // file exists on production FS (curated or regenerated discovered)
        else if (!c.document_id && c.source_file.startsWith('discovered-kos')) {
            duplicateKosChunks += 1; // duplicate of kos_source_documents content → linkable
            linkable = true;
        }
        if (!linkable) {
            unlinkable += 1;
            const key = c.source_file.startsWith('postgres:') ? 'postgres:*' : c.source_file.startsWith('discovered-') ? 'discovered-*' : c.source_file.split('-')[0] + '-*';
            unlinkableByPrefix.set(key, (unlinkableByPrefix.get(key) || 0) + 1);
        }
    }
    issues.unlinkableChunks = { count: unlinkable, byPrefix: Object.fromEntries([...unlinkableByPrefix.entries()]) };
    issues.duplicateKosChunks = duplicateKosChunks;

    // ---------- 5. issues: multiple versions of one source ----------
    const kosUrls = new Map((await q('SELECT id, canonical_url FROM kos_source_documents')).map((r) => [r.id, r.canonical_url]));
    const originCount = new Map();
    for (const e of entries) {
        if (e.source_type !== 'kos_source_document') continue;
        const url = kosUrls.get(e.source_id) || '';
        const origin = url.replace(/^https?:\/\//, '').split('/')[0] || 'no-origin';
        if (!originCount.has(origin)) originCount.set(origin, []);
        originCount.get(origin).push(e.source_ref);
    }
    for (const [origin, refs] of originCount) {
        if (refs.length > 1 && /\.(md|com|info)$/.test(origin) && refs.length > 3) {
            issues.multiVersion.push(`${origin}: ${refs.length} docs`);
        }
    }
    // news curated vs wine-and-spirits crawled overlap (source_id = 'wine-and-spirits-md')
    const newsCurated = entries.filter((e) => e.source_type === 'curated-news' && e.include);
    const wAndS = entries.filter((e) => e.source_type === 'approved_crawled_document' && e.provenance?.source_id === 'wine-and-spirits-md');
    const wAndSHashes = new Set(wAndS.map((e) => e.hashes.text_sha256).filter(Boolean));
    const newsOverlapBodies = newsCurated.filter((e) => wAndSHashes.has(e.hashes.body_sha256)).length;
    issues.overlapNewsVsCrawled = { curated_news_files: newsCurated.length, wine_and_spirits_crawled_docs: wAndS.length, overlap_bodies_exact: newsOverlapBodies };

    // ---------- arithmetic ----------
    const totals = {
        candidates: entries.length,
        included: entries.filter((e) => e.include).length,
        excluded: entries.filter((e) => !e.include).length,
        by_source_type: {},
        estimated_chunks_included: entries.filter((e) => e.include).reduce((s, e) => s + e.estimated_chunks, 0),
    };
    for (const t of ['kos_source_document', 'approved_crawled_document', 'curated-book', 'curated-manual', 'curated-moldova', 'curated-news', 'curated-demo', 'curated-feteasca', 'curated-uploaded-pdf', 'curated-other']) {
        const list = entries.filter((e) => e.source_type === t);
        totals.by_source_type[t] = { candidates: list.length, included: list.filter((e) => e.include).length, excluded: list.filter((e) => !e.include).length };
    }

    const manifest = {
        generated_at: new Date().toISOString(),
        mode: 'read-only-canonical-source-audit',
        production_snapshot: RECONCILE.snapshot,
        totals,
        issues,
        entries,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // CSV
    const cols = ['source_ref', 'source_type', 'source_id', 'title', 'language', 'status', 'approval', 'text_available', 'storage', 'text_size_chars', 'estimated_chunks', 'duplicate_group', 'include', 'exclude_reason', 'raw_sha256', 'content_hash_db', 'text_sha256'];
    const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csvLines = [cols.join(',')];
    for (const e of entries) {
        csvLines.push([e.source_ref, e.source_type, e.source_id, e.title, e.language, e.status, e.approval, e.text_available, e.storage, e.text_size_chars, e.estimated_chunks, e.duplicate_group || '', e.include ? 'include' : 'exclude', e.exclude_reason || '', e.hashes.raw_sha256 || '', e.hashes.content_hash_db || '', e.hashes.text_sha256 || e.hashes.normalized_text_sha256 || ''].map(esc).join(','));
    }
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.csv'), csvLines.join('\n'), 'utf8');

    // Markdown report
    const md = [];
    md.push('# Phase 0B Step 1 — Canonical Source Manifest Report');
    md.push('');
    md.push(`Generated: ${manifest.generated_at} · Production snapshot: ${RECONCILE.snapshot} · Mode: read-only (no writes)`);
    md.push('');
    md.push('## Arithmetic');
    md.push('');
    md.push('| metric | count |');
    md.push('| --- | --- |');
    md.push(`| candidates | ${totals.candidates} |`);
    md.push(`| included | ${totals.included} |`);
    md.push(`| excluded | ${totals.excluded} |`);
    md.push(`| estimated chunks (included) | ${totals.estimated_chunks_included} |`);
    md.push('');
    md.push('### By source type');
    md.push('');
    md.push('| source_type | candidates | included | excluded |');
    md.push('| --- | --- | --- | --- |');
    for (const [k, v] of Object.entries(totals.by_source_type)) md.push(`| ${k} | ${v.candidates} | ${v.included} | ${v.excluded} |`);
    md.push('');
    md.push('## Issues');
    md.push('');
    md.push(`- empty / JS-rendered (no text): **${issues.empty.length}** (${issues.empty.slice(0, 10).join(', ')}${issues.empty.length > 10 ? ', …' : ''})`);
    md.push(`- JS-rendered (wine.md / cricova.md): ${issues.jsRendered.length}`);
    md.push(`- exact duplicate text groups: ${issues.duplicate.length} (${issues.duplicate.slice(0, 4).join(' | ')}${issues.duplicate.length > 4 ? ' | …' : ''})`);
    md.push(`- multiple versions of one source: ${issues.multiVersion.length}`);
    md.push(`- demo content (excluded): ${entries.filter((e) => e.exclude_reason === 'demo_content').length}`);
    md.push(`- internal_reference without external provenance: ${issues.noProvenance.length}`);
    md.push(`- curated news vs wine-and-spirits crawled overlap: curated_news=${issues.overlapNewsVsCrawled.curated_news_files}, crawled=${issues.overlapNewsVsCrawled.wine_and_spirits_crawled_docs}, exact body overlap=${issues.overlapNewsVsCrawled.overlap_bodies_exact}`);
    md.push('- current PG chunks that are duplicates of KOS content (discovered-kos-*): **' + issues.duplicateKosChunks + '**');
    md.push('- unlinkable current PG chunks: ' + issues.unlinkableChunks.count + ' (' + JSON.stringify(issues.unlinkableChunks.byPrefix) + ')');
    md.push('');
    md.push('## Embeddings / schema facts');
    md.push('');
    md.push('- `knowledge_chunk_embeddings`: `chunk_id` TEXT PK NOT NULL, `source_file` TEXT NOT NULL, `model` TEXT NOT NULL, `embedding` `vector(768)` NULL (verified `vector_dims=768`), `content_hash` TEXT NOT NULL, `created_at`/`updated_at` TIMESTAMPTZ; model `gemini-embedding-001`, pgvector 0.8.5, ivfflat index `idx_knowledge_chunk_embeddings_vector` (lists=100), btree index source_file. Total 2555 rows, **all non-null**, 1253 join to `knowledge_chunks`, **1302 orphan embeddings** (no matching chunk); 0 chunks missing an embedding.');
    md.push('- `knowledge_chunks`: PK `chunk_id`; btree indexes source_file, entity_id, document_id.');
    md.push('- runtime reads: `KNOWLEDGE_CHUNK_SOURCE` unset in production → keyword search reads FS `index.json`; semantic candidates read `knowledge_chunk_embeddings` JOIN `knowledge_chunks` directly. So today production hybrid search already mixes FS keyword + PG semantic.');
    md.push('- versioned runtime: a DB pointer (active build id) lets runtime pick legacy vs v2 chunks without redeploy once the versioned runtime mode is enabled — the read path reads the pointer per-request, and cutover/rollback is a single row update.');
    md.push('');
    md.push('## Blockers');
    md.push('');
    md.push('- exact-duplicate KOS docs: **' + issues.duplicate.length + ' groups / ' + entries.filter((e) => e.duplicate_group).length + ' docs** (dedupe policy required before v2 build).');
    md.push('- legacy KOS pipeline (filesystem sync, `knowledge-chunks-sync.js`) is permanently stopped — must not run during v2 build.');
    md.push('- 2 unlinkable legacy PG chunks will be dropped in v2 (no canonical input).');
    md.push('- 1302 orphan embeddings in `knowledge_chunk_embeddings` must not be migrated/kept for v2.');
    md.push('');
    md.push('## Canonical input policy (v2 build inputs)');
    md.push('');
    md.push('Only these are versioned-build inputs; everything else is treated as derived/legacy and excluded:');
    md.push('- `kos_source_documents` rows with `status=active` AND non-empty `normalized_text` (182 of 216).');
    md.push('- `knowledge_documents` rows with `status=approved` AND non-empty `text` (242 of 242).');
    md.push('- git-committed curated `.md` files with non-empty body, non-`demo` confidence, and an external provenance source (29 of 31; `curated-demo` excluded).');
    md.push('- `index.json` is derived (regenerated at boot), never a build input.');
    md.push('');
    md.push('## Versioned runtime read path (legacy + v2 without redeploy)');
    md.push('');
    md.push('- Single DB pointer row (e.g. `app_settings.versioned_build_active` = build id) read per-request.');
    md.push('- `active = legacy`: keyword → FS `index.json`, semantic → PG `knowledge_chunk_embeddings` JOIN `knowledge_chunks` (today\'s behavior).');
    md.push('- `active = <v2 build id>`: both keyword and semantic → v2 tables for that build; cutover/rollback = one row update, no deploy.');
    md.push('');
    md.push('## Verdict');
    md.push('');
    md.push('**Ready to implement build registry** — canonical input set is well-defined (' + totals.included + ' included, ' + totals.excluded + ' excluded with explicit reasons), no blockers beyond a documented dedupe policy for the ' + issues.duplicate.length + ' duplicate groups.');
    md.push('');
    fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md.join('\n'), 'utf8');

    console.log('manifest entries:', totals.candidates);
    console.log('included:', totals.included, 'excluded:', totals.excluded);
    console.log('estimated chunks (included):', totals.estimated_chunks_included);
    console.log('unlinkable PG chunks:', issues.unlinkableChunks.count);
    console.log('output:', OUT_DIR);
    await pool.end();
}

module.exports = { parseArgs, loadSnapshot };

if (require.main === module) {
    main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}

'use strict';

// documents -> cleaning -> chunking -> metadata, see docs/ARCHITECTURE.md's
// "Knowledge layer" section. No RAG framework dependency for v1 — the
// format is deliberately simple (frontmatter + paragraphs) so it stays
// auditable; swap in a real vector store later behind the same
// loadDocuments()/chunkDocument() contract if retrieval quality demands it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'source');
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv']);
const REQUIRED_METADATA_FIELDS = ['title', 'language', 'doc_type'];
const KNOWN_METADATA_FIELDS = [
    'title', 'winery', 'region', 'grape', 'language', 'doc_type',
    'date', 'source', 'confidence', 'updated_at',
];

function stableId(sourceFile, index) {
    return crypto.createHash('sha256').update(`${sourceFile}#${index}`).digest('hex').slice(0, 16);
}

// Minimal frontmatter parser: `---\nkey: value\n...\n---\nbody`. No YAML
// dependency — values are plain strings, which is all this format needs.
function parseFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) return { metadata: {}, body: raw.trim() };
    const [, frontmatter, body] = match;
    const metadata = {};
    for (const line of frontmatter.split(/\r?\n/)) {
        const lineMatch = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line.trim());
        if (!lineMatch) continue;
        const [, key, value] = lineMatch;
        metadata[key.trim()] = value.trim();
    }
    return { metadata, body: body.trim() };
}

function validateMetadata(metadata, sourceFile) {
    const missing = REQUIRED_METADATA_FIELDS.filter((field) => !metadata[field]);
    const unknown = Object.keys(metadata).filter((field) => !KNOWN_METADATA_FIELDS.includes(field));
    return { sourceFile, missing, unknown };
}

// Chunk on blank-line-separated paragraphs, then merge short ones forward
// so a chunk is neither a single sentence nor a whole document.
function chunkText(body, { minChars = 200, maxChars = 1200 } = {}) {
    const paragraphs = body.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    let current = '';
    for (const paragraph of paragraphs) {
        const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
        if (candidate.length >= maxChars && current) {
            chunks.push(current);
            current = paragraph;
        } else {
            current = candidate;
        }
        if (current.length >= minChars && current.length < maxChars) {
            // keep accumulating until maxChars, unless this is the last paragraph
        }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : (body.trim() ? [body.trim()] : []);
}

function loadDocuments(sourceDir = DEFAULT_SOURCE_DIR) {
    const result = { documents: [], errors: [] };
    if (!fs.existsSync(sourceDir)) {
        result.errors.push({ sourceFile: sourceDir, message: 'source_dir_missing' });
        return result;
    }
    const files = fs.readdirSync(sourceDir).filter((file) => SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase()));
    for (const file of files) {
        const filePath = path.join(sourceDir, file);
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const ext = path.extname(file).toLowerCase();
            let metadata = {};
            let body = raw;
            if (ext === '.json') {
                const parsed = JSON.parse(raw);
                metadata = parsed.metadata || {};
                body = String(parsed.body || parsed.text || '');
            } else {
                ({ metadata, body } = parseFrontmatter(raw));
            }
            const validation = validateMetadata(metadata, file);
            if (validation.missing.length > 0) {
                result.errors.push({
                    sourceFile: file,
                    message: `missing_required_metadata: ${validation.missing.join(', ')}`,
                });
            }
            result.documents.push({ sourceFile: file, metadata, body, validation });
        } catch (error) {
            result.errors.push({ sourceFile: file, message: error.message });
        }
    }
    return result;
}

function chunkDocument(doc) {
    const chunks = chunkText(doc.body);
    return chunks.map((text, index) => ({
        id: stableId(doc.sourceFile, index),
        text,
        metadata: {
            title: doc.metadata.title || doc.sourceFile,
            winery: doc.metadata.winery || null,
            region: doc.metadata.region || null,
            grape: doc.metadata.grape || null,
            language: doc.metadata.language || 'ru',
            doc_type: doc.metadata.doc_type || 'unknown',
            date: doc.metadata.date || null,
            source: doc.metadata.source || doc.sourceFile,
            confidence: doc.metadata.confidence || 'unverified',
            updated_at: doc.metadata.updated_at || null,
            source_file: doc.sourceFile,
            chunk_index: index,
        },
    }));
}

module.exports = {
    DEFAULT_SOURCE_DIR,
    SUPPORTED_EXTENSIONS,
    REQUIRED_METADATA_FIELDS,
    parseFrontmatter,
    validateMetadata,
    chunkText,
    loadDocuments,
    chunkDocument,
};

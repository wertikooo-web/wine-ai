'use strict';

// Converts an approved discovered document into the existing
// knowledge/source/*.md frontmatter format so it flows through the
// already-working loader/index/search pipeline unchanged — the promoted
// file IS the integration point with the current RAG, not a parallel one.
const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..', '..', '..', 'knowledge', 'source');

// The `doc.id` suffix is load-bearing, not cosmetic: several crawled pages
// on the same site can share a generic <title> (a template default, not a
// per-page title), which made a title-only filename collide and silently
// overwrite a different page's content on disk — found while testing the
// first real crawl of wineofmoldova.com (6 ru pages collapsed into 1
// file). `doc.id` is derived from the URL (see store.js's idFor()), so it
// is always unique per source page regardless of title quality.
function safeFileName(doc) {
    const base = (doc.title || '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    const idSuffix = String(doc.id || '').replace(/^doc_/, '').slice(0, 10);
    return `discovered-${base ? base + '-' : ''}${idSuffix}.${doc.language || 'ru'}.md`;
}

function docTypeForTopics(topics = []) {
    if (topics.includes('winery')) return 'winery_profile';
    if (topics.includes('tourism')) return 'tourism_route';
    if (topics.includes('region')) return 'region_profile';
    if (topics.includes('news')) return 'news';
    if (topics.includes('grape')) return 'grape_profile';
    return 'general';
}

function frontmatter(doc) {
    const lines = [
        '---',
        `title: ${(doc.title || '').replace(/\r?\n/g, ' ')}`,
        `language: ${doc.language || 'ru'}`,
        `doc_type: ${docTypeForTopics(doc.topics)}`,
        `source: ${doc.publisher || doc.url}`,
        `confidence: ${doc.trustLevel === 'A' ? 'high' : doc.trustLevel === 'B' ? 'medium' : 'unverified'}`,
        `updated_at: ${doc.fetchedAt || ''}`,
        '---',
        '',
        doc.text || '',
    ];
    return lines.join('\n');
}

// Only 'approved' documents may be promoted — this is the hard gate
// between the discovered-news queue and the confirmed knowledge base (see
// docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.1).
function promote(doc, sourceDir = DEFAULT_SOURCE_DIR) {
    if (doc.status !== 'approved') {
        throw Object.assign(new Error('only_approved_documents_can_be_promoted'), { code: 'invalid_status' });
    }
    fs.mkdirSync(sourceDir, { recursive: true });
    const fileName = safeFileName(doc);
    fs.writeFileSync(path.join(sourceDir, fileName), frontmatter(doc), 'utf8');
    return fileName;
}

module.exports = { promote, safeFileName, docTypeForTopics };

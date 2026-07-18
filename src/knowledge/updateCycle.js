'use strict';

// Full update cycle — see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.8.
//
//   check sources -> crawl -> clean -> dedup -> classify trust ->
//   auto-approve trust A -> promote approved -> reindex -> report
//
// Extracted from scripts/knowledge-update.js so both the CLI script and
// the dashboard's "run update" HTTP route call the exact same logic
// in-process — a detached background child process turned out to be
// undebuggable in this Railway environment (its own console output never
// reached `railway logs`, for reasons not fully root-caused; running the
// cycle in-process sidesteps the question entirely).
const fs = require('fs');
const path = require('path');
const { listPages } = require('./sources/registry');
const { fetchPage } = require('./crawler/fetchPage');
const { cleanText, contentHash, isSubstantial } = require('./processor/clean');
const store = require('./discovered/store');
const { promote } = require('./discovered/promote');
const { buildIndex } = require('./index');

const REPORTS_DIR = path.resolve(__dirname, '..', '..', 'knowledge', 'reports');
const REPORT_FILE = path.join(REPORTS_DIR, 'latest.json');
const MIN_UPDATE_INTERVAL_HOURS = Number(process.env.KNOWLEDGE_UPDATE_MIN_INTERVAL_HOURS || 72);

function readLastReport() {
    if (!fs.existsSync(REPORT_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function hoursSince(isoString) {
    return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60);
}

function writeReport(report) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
}

async function runUpdateCycle({ force = false, log = console.log, warn = console.warn } = {}) {
    const last = readLastReport();
    if (!force && last?.completedAt && hoursSince(last.completedAt) < MIN_UPDATE_INTERVAL_HOURS) {
        const remaining = (MIN_UPDATE_INTERVAL_HOURS - hoursSince(last.completedAt)).toFixed(1);
        const message = `skipped — last run ${hoursSince(last.completedAt).toFixed(1)}h ago, minimum interval ${MIN_UPDATE_INTERVAL_HOURS}h (${remaining}h remaining)`;
        log(`[knowledge:update] ${message}`);
        return { skipped: true, message };
    }

    const startedAt = new Date().toISOString();
    const pages = listPages();
    const report = {
        startedAt,
        completedAt: null,
        sourcesChecked: pages.length,
        newDocuments: 0,
        duplicates: 0,
        autoApproved: 0,
        pendingReview: 0,
        errors: [],
    };

    for (const page of pages) {
        try {
            const fetched = await fetchPage(page.url);
            const text = cleanText(fetched.text);
            if (!isSubstantial(text)) {
                report.errors.push({ url: page.url, message: 'page_too_short_or_empty' });
                continue;
            }
            const hash = contentHash(text);

            const existingByUrl = await store.findByUrl(page.url);
            if (existingByUrl && existingByUrl.contentHash === hash) {
                report.duplicates += 1;
                continue; // seen this exact content at this URL before
            }
            const existingByHash = !existingByUrl && await store.findByContentHash(hash);
            if (existingByHash) {
                report.duplicates += 1;
                continue; // same content already stored under a different URL
            }

            // Trust A auto-approves the DOCUMENT. Sensitive fact categories
            // (prices, hours, availability, contacts, vintages, awards,
            // ownership) are NOT extracted/verified in v1 at all — no
            // field-level fact extraction yet (see architecture doc §13.2
            // and the Extractor module planned for a later stage). Nothing
            // here claims to have verified individual facts within the
            // text, only that the document itself came from a trust-A
            // source and is safe to feed into retrieval as page content.
            const status = page.trust === 'A' ? 'approved' : 'pending';
            await store.save({
                id: existingByUrl?.id,
                title: fetched.title,
                url: page.url,
                publisher: page.publisher,
                publishedAt: null,
                fetchedAt: fetched.fetchedAt,
                language: page.language,
                sourceId: page.sourceId,
                trustLevel: page.trust,
                contentHash: hash,
                topics: page.topics,
                entities: { wineries: [], wines: [], grapes: [], regions: [] },
                summary: text.slice(0, 240),
                status,
                text,
                lastVerifiedAt: new Date().toISOString(),
            });

            report.newDocuments += 1;
            if (status === 'approved') {
                report.autoApproved += 1; // actual file write happens in the republish pass below
            } else {
                report.pendingReview += 1;
            }
        } catch (error) {
            report.errors.push({ url: page.url, message: error.message });
        }
    }

    // Re-promote every currently-approved document, not just ones approved
    // in this run — makes the step idempotent/self-healing (e.g. after
    // manually clearing knowledge/source/, or after an approve happens via
    // the dashboard between scheduled runs) instead of only ever promoting
    // on the one run a document first became approved.
    let republished = 0;
    for (const doc of await store.loadAll()) {
        if (doc.status === 'approved') {
            promote(doc);
            republished += 1;
        }
    }
    report.approvedDocumentsPublished = republished;

    const indexResult = buildIndex();
    report.completedAt = new Date().toISOString();
    report.indexedDocumentCount = indexResult.documentCount;
    report.indexedChunkCount = indexResult.chunkCount;
    writeReport(report);

    log(`[knowledge:update] sources=${report.sourcesChecked} new=${report.newDocuments} duplicates=${report.duplicates} auto_approved=${report.autoApproved} pending=${report.pendingReview} errors=${report.errors.length}`);
    if (report.errors.length) {
        for (const err of report.errors) warn(`  - ${err.url}: ${err.message}`);
    }
    return { skipped: false, report };
}

module.exports = { runUpdateCycle, REPORT_FILE };

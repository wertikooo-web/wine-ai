'use strict';

// Full update cycle — see docs/KNOWLEDGE_PIPELINE_ARCHITECTURE.md §13.8.
//
//   check sources -> crawl -> clean -> dedup -> classify trust ->
//   auto-approve trust A -> promote approved -> reindex -> report
//
// Run manually: `npm run knowledge:update`
// Run on a schedule (Railway cron): daily trigger, but this script exits
// immediately if MIN_UPDATE_INTERVAL_HOURS hasn't elapsed since the last
// successful run — see §13.6 for why (a fixed "every 3rd day" cron
// expression resets at month boundaries; checking elapsed time doesn't).
const fs = require('fs');
const path = require('path');
const { listPages } = require('../src/knowledge/sources/registry');
const { fetchPage } = require('../src/knowledge/crawler/fetchPage');
const { cleanText, contentHash, isSubstantial } = require('../src/knowledge/processor/clean');
const store = require('../src/knowledge/discovered/store');
const { promote } = require('../src/knowledge/discovered/promote');
const { buildIndex } = require('../src/knowledge/index');

const REPORTS_DIR = path.resolve(__dirname, '..', 'knowledge', 'reports');
const REPORT_FILE = path.join(REPORTS_DIR, 'latest.json');
const MIN_UPDATE_INTERVAL_HOURS = Number(process.env.KNOWLEDGE_UPDATE_MIN_INTERVAL_HOURS || 72);
const FORCE = /^(1|true|yes)$/i.test(String(process.env.KNOWLEDGE_UPDATE_FORCE || ''));

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

async function main() {
    const last = readLastReport();
    if (!FORCE && last?.completedAt && hoursSince(last.completedAt) < MIN_UPDATE_INTERVAL_HOURS) {
        const remaining = (MIN_UPDATE_INTERVAL_HOURS - hoursSince(last.completedAt)).toFixed(1);
        console.log(`[knowledge:update] skipped — last run ${hoursSince(last.completedAt).toFixed(1)}h ago, minimum interval ${MIN_UPDATE_INTERVAL_HOURS}h (${remaining}h remaining). Set KNOWLEDGE_UPDATE_FORCE=1 to override.`);
        return;
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

    console.log(`[knowledge:update] sources=${report.sourcesChecked} new=${report.newDocuments} duplicates=${report.duplicates} auto_approved=${report.autoApproved} pending=${report.pendingReview} errors=${report.errors.length}`);
    if (report.errors.length) {
        for (const err of report.errors) console.warn(`  - ${err.url}: ${err.message}`);
    }
}

main()
    .catch((error) => {
        console.error('[knowledge:update] FAILED:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        // A live pg.Pool has open sockets that would otherwise keep this
        // one-shot script's process alive indefinitely after main() returns
        // (this is a run-once cron/manual job, not the long-lived server).
        const db = require('../src/knowledge/db');
        if (db.isEnabled()) await db.getPool().end();
    });

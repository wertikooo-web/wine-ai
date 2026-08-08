'use strict';

// Phase 1 DoD demo: run the same real question through the four answer modes
// against real retrieval (Postgres via the Railway tunnel), printing for each
// mode which levels were allowed, which evidence actually survived, and the
// per-claim provenance. Intentionally deterministic output; never prints the
// connection string.
//
// Run with the tunnel URL available (TUNNEL_PG_URL_FILE, or the local-pg-url
// temp file produced by the hold-tunnel wrapper):
//   node scripts/answer-modes-demo.js "Сколько стоит Purcari Negru?"
//   node scripts/answer-modes-demo.js --list
//   node scripts/answer-modes-demo.js "Cricova история" ro

const path = require('path');
const fs = require('fs');
const os = require('os');
const { orchestrateKnowledge } = require('../src/knowledge/knowledgeOrchestrator');
const { listAnswerModes, ANSWER_MODES } = require('../src/knowledge/answerModes');

function resolveDatabaseUrl() {
    const fileHint = process.env.TUNNEL_PG_URL_FILE;
    if (fileHint && fs.existsSync(fileHint)) return fs.readFileSync(fileHint, 'utf8').trim();
    const tempDefault = path.join(os.tmpdir(), 'local-pg-url.txt');
    if (fs.existsSync(tempDefault)) return fs.readFileSync(tempDefault, 'utf8').trim();
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    return null;
}

function summarizeMode(mode) {
    const modes = new Map(listAnswerModes().map((m) => [m.mode, m]));
    const info = modes.get(mode);
    return {
        mode,
        levels: info.levels,
        allowWeb: info.allowWeb,
        allowCatalog: info.allowCatalog,
        allowInference: info.allowInference,
    };
}

function printClaim(claim, index) {
    console.log(`\n  [${index}. ${claim.kind}] ${claim.claim}`);
    console.log(`    confidence: ${claim.confidence || 'n/a'}`);
    if (claim.entity_id) console.log(`    entity: ${claim.entity_id}`);
    const source = claim.source || {};
    console.log(`    source_type: ${source.type || 'n/a'}`);
    if (source.title) console.log(`    source_title: ${source.title}`);
    if (source.url) console.log(`    source_url: ${source.url.length > 90 ? source.url.slice(0, 90) + '…' : source.url}`);
    if (source.document_page) console.log(`    document_page: ${source.document_page}`);
    if (claim.freshness?.as_of) console.log(`    brought/verified at: ${claim.freshness.as_of}`);
    const syncAt = source.checked_at || source.verified_at;
    if (syncAt && syncAt !== claim.freshness?.as_of) console.log(`    checked/verified at: ${syncAt}`);
    if (claim.conflict) console.log(`    conflict: ${claim.conflict.key} in {${claim.conflict.values.join(' | ')}}`);
}

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--list') {
        console.log(JSON.stringify(listAnswerModes(), null, 2));
        return;
    }
    const question = args[0] || 'Какова история Beyirtele?';
    const language = args[1] || 'ru';
    const modes = [ANSWER_MODES.KNOWLEDGE_ONLY, ANSWER_MODES.KNOWLEDGE_CATALOG, ANSWER_MODES.KNOWLEDGE_WEB, ANSWER_MODES.EXPERT];

    const url = resolveDatabaseUrl();
    if (url) {
        // The URL must live in the environment only, never echoed to stdout.
        process.env.DATABASE_URL = url;
    }

    console.log(`QUESTION: ${question}`);
    console.log(`LANGUAGE: ${language}`);
    if (process.env.DATABASE_URL) {
        console.log('DB: connected via tunnel (URL not printed)');
    } else {
        console.warn('WARNING: no DATABASE_URL/tunnel URL found — retrieval will be constrained to in-memory/document levels only.');
    }

    for (const mode of modes) {
        const summary = summarizeMode(mode);
        console.log(`\n=== MODE: ${summary.mode} ===`);
        console.log(`allowed_levels: ${summary.levels.join(', ')}  web=${summary.allowWeb} catalog=${summary.allowCatalog}`);

        const result = await orchestrateKnowledge(question, { language, answerMode: mode });
        console.log(`    answerable: ${result.answerable}  found: ${result.found}`);
        console.log(`    used_levels: ${result.used_levels.join(', ') || '(none)'}  web_used: ${result.web_used}`);
        console.log(`    freshness_sensitive: ${result.freshness?.freshness_sensitive}  dynamic_fields: ${result.freshness?.dynamic_fields_present}`);
        if (result.freshness?.newest_checked_at) console.log(`    newest_checked_at: ${result.freshness.newest_checked_at}`);
        if (result.conflicts.length) console.log(`    conflicts: ${result.conflicts.map((c) => `${c.key} in {${c.values.join(' | ')}}`).join('; ')}`);
        if (!result.claims.length) {
            console.log('    (no evidence — nothing to classify)');
            continue;
        }
        result.claims.forEach(printClaim);
        if (result.narrative) console.log(`\n  narrative: ${result.narrative}`);
    }
    console.log('\nDONE');
}

if (require.main === module) {
    main().catch((error) => {
        console.error('demo failed:', error?.message || error);
        process.exit(1);
    });
}

module.exports = { resolveDatabaseUrl, summarizeMode, printClaim, main };
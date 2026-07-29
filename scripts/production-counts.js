'use strict';
const db = require('../src/knowledge/db');

async function main() {
    const pool = db.getPool();
    if (!pool) {
        console.error('DATABASE_URL not set');
        process.exit(1);
    }

    const queries = [
        { name: 'kos_source_documents', sql: 'SELECT COUNT(*) as c FROM kos_source_documents' },
        { name: 'entity_facts', sql: 'SELECT COUNT(*) as c FROM entity_facts' },
        { name: 'entity_facts_provenance', sql: 'SELECT COUNT(*) as c FROM entity_facts_provenance' },
        { name: 'knowledge_chunk_embeddings', sql: 'SELECT COUNT(*) as c FROM knowledge_chunk_embeddings' },
        { name: 'kos_crawl_run_items', sql: 'SELECT COUNT(*) as c FROM kos_crawl_run_items' },
        { name: 'kos_crawl_runs', sql: 'SELECT COUNT(*) as c FROM kos_crawl_runs' },
        { name: 'active_documents', sql: "SELECT COUNT(*) as c FROM kos_source_documents WHERE status = 'active'" },
        { name: 'active_facts', sql: 'SELECT COUNT(*) as c FROM entity_facts WHERE active = true' },
    ];

    for (const q of queries) {
        try {
            const { rows } = await pool.query(q.sql);
            console.log(`  ${q.name}: ${rows[0].c}`);
        } catch (e) {
            console.log(`  ${q.name}: ERROR - ${e.message}`);
        }
    }

    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });

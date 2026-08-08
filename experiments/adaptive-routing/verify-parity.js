'use strict';
/*
 * Hand-verification for issue #49 (judge evidence parity).
 *
 * Takes cases the PR #48 run flagged as containing "unsupported claims" and
 * shows, for each, whether the claim text actually appears in the evidence the
 * GENERATOR saw versus the truncated 8x700 projection the JUDGE used to see.
 * A claim present in the full view but absent from the truncated view is a
 * judge-truncation artifact, not a real unsupported claim.
 *
 * Retrieval only -- no generation, no judging, no DB writes.
 */
if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const fs = require('fs');
const path = require('path');
const searchWineKnowledge = require('../../src/tools/searchLayeredKnowledge');

const CASES = [
    { id: 'q070', q: 'Какой сортовой состав у Purcari Negru de Purcari?', lang: 'ru', claims: ['55', '40', '5', 'Саперави', 'Rara Neagr', 'Рара'] },
    { id: 'q050', q: 'Чем известна винодельня Cricova?', lang: 'ru', claims: ['120', '60', 'Шарма', 'Шуман'] },
    { id: 'q049', q: 'Расскажи о винодельне Purcari.', lang: 'ru', claims: ['Parcela', 'Viorica', 'Alb de Purcari'] },
    { id: 'q054', q: 'Расскажи о Vinaria din Vale.', lang: 'ru', claims: ['Давидеску', 'Bruxelles', 'Saperavi', 'Decanter'] },
];

// Mirrors the OLD (buggy) judge view.
function truncatedView(evidence) {
    return evidence.slice(0, 8).map((e) => String(e.text || '').slice(0, 700)).join('\n');
}
function fullView(evidence) {
    return evidence.map((e) => String(e.text || '')).join('\n');
}

(async () => {
    const out = [];
    for (const c of CASES) {
        let tool;
        try {
            tool = await searchWineKnowledge.impl({ query: c.q, language: c.lang }, {});
        } catch (e) {
            out.push({ id: c.id, error: String(e.message) });
            fs.writeFileSync(path.join(__dirname, 'verify-parity-out.json'), JSON.stringify(out, null, 1));
            continue;
        }
        const ev = tool.evidence || [];
        const full = fullView(ev);
        const trunc = truncatedView(ev);
        const rec = {
            id: c.id,
            question: c.q,
            evidence_items_generator: ev.length,
            evidence_items_old_judge: Math.min(ev.length, 8),
            evidence_chars_generator: full.length,
            evidence_chars_old_judge: trunc.length,
            chars_hidden_from_old_judge: full.length - trunc.length,
            claims: c.claims.map((k) => ({
                claim_fragment: k,
                in_generator_view: full.includes(k),
                in_old_truncated_judge_view: trunc.includes(k),
                verdict: full.includes(k) && !trunc.includes(k)
                    ? 'TRUNCATION_ARTIFACT (grounded, was scored unsupported)'
                    : (full.includes(k) ? 'grounded in both views' : 'genuinely absent from evidence'),
            })),
        };
        out.push(rec);
        console.log(JSON.stringify(rec, null, 1));
        fs.writeFileSync(path.join(__dirname, 'verify-parity-out.json'), JSON.stringify(out, null, 1));
    }
    process.exit(0);
})();

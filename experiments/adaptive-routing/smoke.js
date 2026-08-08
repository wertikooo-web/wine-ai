'use strict';
/*
 * Gate smoke test (RESEARCH ONLY, read-only vs staging).
 *
 * Drives the REAL production tool path -- src/tools/searchLayeredKnowledge.js
 * -> routeKnowledgeWithAnswerabilityGate -- and then generates the assistant
 * answer exactly as run.js's RAG condition does, so what we inspect is what a
 * user would actually hear. Not a text-only proxy.
 *
 * Writes results to smoke-results.json incrementally so a killed shell still
 * leaves the real output behind.
 */

if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { buildRealtimeSystemInstruction } = require('../../src/realtime/realtimePrompt');
const searchWineKnowledge = require('../../src/tools/searchLayeredKnowledge');

const MODEL = process.env.EXP_MODEL || 'gemini-2.5-flash';
const OUT = path.join(__dirname, 'smoke-results.json');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const CASES = [
    // --- general (5): expect a normal answer even with weak retrieval ---
    { id: 'gen-1', group: 'general', lang: 'ru', text: 'Что такое яблочно-молочное брожение и зачем оно нужно?' },
    { id: 'gen-2', group: 'general', lang: 'ru', text: 'Почему танины в вине ощущаются вяжущими?' },
    { id: 'gen-3', group: 'general', lang: 'ru', text: 'Зачем вино выдерживают в дубовой бочке?' },
    { id: 'gen-4', group: 'general', lang: 'ru', text: 'Чем Пино Нуар отличается от Каберне Совиньон по вкусу вина?' },
    { id: 'gen-5', group: 'general', lang: 'ru', text: 'Какое вино подходит к утке?' },
    // --- known entities (5): expect recognized -> grounding required ---
    { id: 'ent-1', group: 'known_entity', lang: 'ru', text: 'Расскажи про винодельню Purcari.' },
    { id: 'ent-2', group: 'known_entity', lang: 'ru', text: 'Что такое Aurelius?' },
    { id: 'ent-3', group: 'known_entity', lang: 'ru', text: 'Расскажи про Vinaria din Vale.' },
    { id: 'ent-4', group: 'known_entity', lang: 'ru', text: 'Что производит Cricova?' },              // major, Ghid registry
    { id: 'ent-5', group: 'known_entity', lang: 'ru', text: 'Расскажи про винодельню Gogu Winery.' },  // obscure, Ghid registry
    // --- unknown / dangerous (5): expect no confident unsupported claims ---
    { id: 'unk-1', group: 'unknown', lang: 'ru', text: 'Расскажи про Lion Gri.' },
    { id: 'unk-2', group: 'unknown', lang: 'ru', text: 'Расскажи про винодельню Chateau Fabulescu.' },
    { id: 'unk-3', group: 'unknown', lang: 'ru', text: 'Какая крепость у вина Timbrus Rara Neagra 2019?' },
    { id: 'unk-4', group: 'unknown', lang: 'ru', text: 'Какие награды получило вино Novak Riton в 2023 году?' },
    { id: 'unk-5', group: 'unknown', lang: 'ru', text: 'Кто главный винодел на винодельне Minis Terrios и с какого года?' },
    // --- multi-turn (>=2 follow-ups): expect referent preserved ---
    {
        id: 'mt-1', group: 'multiturn', lang: 'ru',
        turns: ['Покажи три Rară Neagră до 300 леев', 'А какое из них легче?', 'А где находится второе?'],
    },
];

function sysInstruction(recentTurns) {
    return buildRealtimeSystemInstruction({
        currentContext: {
            localDateTime: new Date().toISOString(),
            sessionLanguage: 'ru',
            mode: 'text_experiment',
            recentTurns,
        },
    }).text;
}

function textOf(res) {
    if (typeof res?.text === 'string' && res.text.trim()) return res.text.trim();
    return (res?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
}

async function withRetry(fn, label, tries = 5) {
    let last;
    for (let i = 0; i < tries; i += 1) {
        try { return await fn(); } catch (e) {
            last = e;
            if (!/429|503|500|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONN/i.test(String(e?.message))) break;
            await new Promise((r) => setTimeout(r, 8000 * (i + 1)));
        }
    }
    throw new Error(`${label}: ${last?.message || 'unknown'}`);
}

async function runTurn(question, history, lang) {
    // recentTurns is what the multi-turn fix threads through toolContext in
    // realtimeServer.js; the smoke test must exercise that same path.
    const recentTurns = history.flatMap((h) => ([
        { role: 'user', text: h.q }, { role: 'assistant', text: h.a },
    ]));
    const t0 = Date.now();
    let tool;
    try {
        tool = await searchWineKnowledge.impl({ query: question, language: lang }, { recentTurns });
    } catch (e) {
        tool = { found: false, status: 'tool_error', error: String(e.message), evidence: [] };
    }
    const retrieval_ms = Date.now() - t0;

    const contents = [];
    for (const h of history) {
        contents.push({ role: 'user', parts: [{ text: h.q }] });
        contents.push({ role: 'model', parts: [{ text: h.a }] });
    }
    contents.push({ role: 'user', parts: [{ text: question }] });
    contents.push({ role: 'model', parts: [{ functionCall: { name: 'search_wine_knowledge', args: { query: question, language: lang } } }] });
    contents.push({ role: 'user', parts: [{ functionResponse: { name: 'search_wine_knowledge', response: tool } }] });

    const t1 = Date.now();
    const res = await withRetry(() => ai.models.generateContent({
        model: MODEL, contents,
        config: { systemInstruction: sysInstruction(recentTurns), temperature: 0.6, maxOutputTokens: 900 },
    }), 'generate');

    return {
        question,
        answer: textOf(res),
        retrieval_ms,
        generation_ms: Date.now() - t1,
        gate: {
            found: tool.found === true,
            status: tool.status || null,
            answerable: tool.answerable ?? null,
            answerability_reason: tool.answerabilityReason || null,
            claim_class: tool.claimClass || null,
            entity_match: tool.entityMatch || null,
            query_enriched: tool.queryEnriched ?? null,
            enriched_query: tool.enrichedQuery || null,
            used_levels: tool.used_levels || [],
            evidence_count: (tool.evidence || []).length,
            final_instruction: tool.answer_policy?.final_instruction || null,
        },
    };
}

async function main() {
    const results = [];
    // SMOKE_ONLY=ent-2,unknown runs a subset (by case id or group), so a single
    // defect can be re-verified in seconds instead of re-running every live case.
    const only = (process.env.SMOKE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
    const selected = only.length ? CASES.filter((c) => only.includes(c.id) || only.includes(c.group)) : CASES;
    for (const c of selected) {
        const turns = c.turns || [c.text];
        const history = [];
        const steps = [];
        for (const q of turns) {
            const step = await runTurn(q, history, c.lang).catch((e) => ({ question: q, error: String(e.message) }));
            steps.push(step);
            history.push({ q, a: step.answer || '' });
        }
        results.push({ id: c.id, group: c.group, steps });
        console.log(`[smoke] ${c.id} done`);
        fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, results }, null, 1));
    }
    fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, finished: new Date().toISOString(), results }, null, 1));
    console.log('SMOKE DONE ->', OUT);
    process.exit(0);
}

main();

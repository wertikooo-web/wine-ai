'use strict';
/*
 * LOOP B -- answer quality, real API calls, scoped sample.
 *
 * For each sampled item, generates BOTH answers:
 *   direct   -- real persona system instruction, NO tools (what the router's
 *               DIRECT path would actually produce)
 *   grounded -- real production tool impl (searchLayeredKnowledge ->
 *               routeKnowledgeWithAnswerabilityGate), result fed back as a
 *               functionResponse exactly like the voice pipeline
 * and judges them head-to-head.
 *
 * The judge uses the EVIDENCE-PARITY-FIXED methodology from Phase 0 (issue
 * #49): it is given the generator's own evidence array, unmodified -- same
 * item count, same order, full chunk text. No 8x700 truncation.
 *
 * Resumable and checkpointed: every completed item is appended to the output
 * file immediately, and an existing output file is loaded on start so already-
 * completed ids are skipped. Run it repeatedly with EXP_BATCH until done.
 *
 * Never writes to Postgres (db.init() is deliberately NOT called).
 */

if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { buildRealtimeSystemInstruction } = require('../../src/realtime/realtimePrompt');
const searchWineKnowledge = require('../../src/tools/searchLayeredKnowledge');
const { routeSelective } = require('../../src/knowledge/selectiveRagRouter');

const MODEL = process.env.EXP_MODEL || 'gemini-2.5-flash';
const JUDGE_MODEL = process.env.EXP_JUDGE_MODEL || 'gemini-2.5-flash';
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY || 3);
const BATCH = Number(process.env.EXP_BATCH || 8);
const OUT = path.join(__dirname, 'loop-b-results.json');
const SAMPLE = path.join(__dirname, 'loop-b-sample.json');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
function usageOf(res) {
    const u = res?.usageMetadata;
    return u ? { prompt_tokens: u.promptTokenCount ?? null, output_tokens: u.candidatesTokenCount ?? null, total_tokens: u.totalTokenCount ?? null } : null;
}
async function withRetry(fn, label, tries = 6) {
    let last;
    for (let i = 0; i < tries; i += 1) {
        try { return await fn(); } catch (e) {
            last = e;
            if (!/429|503|500|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONN/i.test(String(e?.message || ''))) break;
            await new Promise((r) => setTimeout(r, 8000 * (i + 1) + Math.random() * 4000));
        }
    }
    throw new Error(`${label}: ${last?.message || 'unknown'}`);
}
async function generate({ system, contents }) {
    return withRetry(() => ai.models.generateContent({
        model: MODEL, contents,
        config: { systemInstruction: system, temperature: 0.6, maxOutputTokens: 900 },
    }), 'generate');
}

function historyContents(history) {
    const c = [];
    for (const h of history) {
        c.push({ role: 'user', parts: [{ text: h.q }] });
        c.push({ role: 'model', parts: [{ text: h.a }] });
    }
    return c;
}
function recentTurnsOf(history) {
    return history.flatMap((h) => ([{ role: 'user', text: h.q }, { role: 'assistant', text: h.a }]));
}

async function runDirect(question, history) {
    const contents = [...historyContents(history), { role: 'user', parts: [{ text: question }] }];
    const t0 = Date.now();
    const res = await generate({ system: sysInstruction(recentTurnsOf(history)), contents });
    return { answer: textOf(res), latency_ms: Date.now() - t0, usage: usageOf(res) };
}

async function runGrounded(question, history, lang) {
    const t0 = Date.now();
    let tool;
    try {
        tool = await searchWineKnowledge.impl({ query: question, language: lang }, { recentTurns: recentTurnsOf(history) });
    } catch (e) {
        tool = { found: false, status: 'tool_error', error: String(e.message), evidence: [] };
    }
    const retrieval_ms = Date.now() - t0;
    const contents = [
        ...historyContents(history),
        { role: 'user', parts: [{ text: question }] },
        { role: 'model', parts: [{ functionCall: { name: 'search_wine_knowledge', args: { query: question, language: lang } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search_wine_knowledge', response: tool } }] },
    ];
    const t1 = Date.now();
    const res = await generate({ system: sysInstruction(recentTurnsOf(history)), contents });
    const generation_ms = Date.now() - t1;
    return {
        answer: textOf(res),
        latency_ms: retrieval_ms + generation_ms,
        retrieval_ms,
        generation_ms,
        usage: usageOf(res),
        // PARITY: the generator's own evidence array, unmodified. Deleted
        // before persisting (see runItem).
        judgeEvidence: Array.isArray(tool.evidence) ? tool.evidence : [],
        retrieval: {
            found: tool.found === true, answerable: tool.answerable ?? null,
            status: tool.status || null, claim_class: tool.claimClass || null,
            entity_match: tool.entityMatch || null, web_used: tool.webUsed === true,
            evidence_count: (tool.evidence || []).length,
        },
    };
}

const SCORE = {
    type: 'object',
    properties: {
        quality: { type: 'integer' }, factuality: { type: 'integer' },
        relevance: { type: 'integer' }, naturalness: { type: 'integer' },
        unverified_specific_claims: { type: 'array', items: { type: 'string' } },
        attributes_fact_to_named_producer: { type: 'boolean' },
        notes: { type: 'string' },
    },
    required: ['quality', 'factuality', 'relevance', 'naturalness', 'unverified_specific_claims', 'attributes_fact_to_named_producer', 'notes'],
};
const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        direct: SCORE,
        grounded: SCORE,
        grounding_necessary: { type: 'boolean' },
        better_answer: { type: 'string', enum: ['direct', 'grounded', 'tie'] },
        retrieval_effect: { type: 'string', enum: ['helped', 'neutral', 'harmed'] },
        verdict: { type: 'string', enum: ['DIRECT_SUFFICIENT', 'GROUNDING_REQUIRED', 'AMBIGUOUS'] },
        explanation: { type: 'string' },
    },
    required: ['direct', 'grounded', 'grounding_necessary', 'better_answer', 'retrieval_effect', 'verdict', 'explanation'],
};

// Same serialization as the Phase 0 fix: full item count, full chunk text.
function formatEvidenceForJudge(evidence) {
    if (!Array.isArray(evidence) || !evidence.length) return '(no evidence retrieved)';
    return evidence.map((e, i) => `[${i + 1}] (${e.level || '?'}/${e.confidence ?? '?'}) ${e.title || ''}\n${String(e.text || '')}`).join('\n\n');
}

function judgePrompt(question, direct, grounded) {
    return `Ты строгий эксперт-оценщик для голосового ИИ-сомелье "WINE AI" (проект о молдавском вине).

Оцени ДВА ответа на один и тот же вопрос.
- Ответ A ("direct") сгенерирован БЕЗ поиска, только из знаний модели.
- Ответ B ("grounded") сгенерирован ПОСЛЕ поиска в базе WINE AI. Ниже приведены ПОЛНОСТЬЮ все фрагменты, которые видел генератор ответа B — ничего не обрезано.

Шкала 1-5 (5 — отлично):
- quality: полезность и полнота
- factuality: фактическая корректность. КРИТИЧНО: если ответ уверенно называет конкретный факт (цену, год урожая, крепость, тираж, имя винодела, награду, часы работы) о КОНКРЕТНОЙ названной винодельне или вине, и он НЕ подтверждается фрагментами и не является общеизвестным — factuality не выше 2.
- relevance / naturalness: по вопросу; живая разговорная речь для голосового ассистента.

Также по каждому ответу:
- unverified_specific_claims: конкретные непроверяемые утверждения (цены, годы, проценты, названия продуктов, награды, имена).
- attributes_fact_to_named_producer: true, если ответ приписывает конкретный факт КОНКРЕТНОЙ названной винодельне/вину.

И по паре:
- grounding_necessary: были ли собственные данные WINE AI действительно нужны?
- better_answer: какой ответ лучше для пользователя.
- retrieval_effect: helped / neutral / harmed.
- verdict: DIRECT_SUFFICIENT / GROUNDING_REQUIRED / AMBIGUOUS.

ВОПРОС: ${question}

ОТВЕТ A (direct):
${direct.answer || '(пусто)'}

ПОЛНЫЕ ИЗВЛЕЧЁННЫЕ ФРАГМЕНТЫ (то, что видел генератор ответа B):
${formatEvidenceForJudge(grounded.judgeEvidence)}

ОТВЕТ B (grounded):
${grounded.answer || '(пусто)'}

Верни строгий JSON по схеме.`;
}

async function judge(question, direct, grounded) {
    const res = await withRetry(() => ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: judgePrompt(question, direct, grounded) }] }],
        config: { temperature: 0, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json', responseSchema: JUDGE_SCHEMA },
    }), 'judge');
    const raw = textOf(res);
    try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw); } catch { return { parse_error: true, raw: raw.slice(0, 600) }; }
}

async function runItem(item) {
    const turns = item.turns || [item.text];
    const history = [];
    const steps = [];
    for (let i = 0; i < turns.length; i += 1) {
        const q = turns[i];
        const decisionObj = routeSelective(q, { recentTurns: recentTurnsOf(history) });
        const [direct, grounded] = await Promise.all([
            runDirect(q, history).catch((e) => ({ answer: '', error: String(e.message), latency_ms: null, usage: null })),
            runGrounded(q, history, item.lang).catch((e) => ({ answer: '', error: String(e.message), latency_ms: null, usage: null, judgeEvidence: [], retrieval: null })),
        ]);
        const graded = (direct.answer && grounded.answer) ? await judge(q, direct, grounded).catch((e) => ({ error: String(e.message) })) : { skipped: 'missing_answer' };
        const judge_evidence_count = grounded.judgeEvidence.length;
        const judge_evidence_chars = grounded.judgeEvidence.reduce((n, e) => n + String(e.text || '').length, 0);
        delete grounded.judgeEvidence;
        steps.push({ turn: i + 1, question: q, router: decisionObj, direct, grounded, judge_evidence_count, judge_evidence_chars, judge: graded });
        history.push({ q, a: grounded.answer || direct.answer || '' });
    }
    return { id: item.id, category: item.category, expected: item.expected, lang: item.lang, steps };
}

function loadSample() {
    return JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
}

async function main() {
    const sample = loadSample();
    let done = [];
    if (fs.existsSync(OUT)) done = JSON.parse(fs.readFileSync(OUT, 'utf8')).results || [];
    const doneIds = new Set(done.map((r) => r.id));
    const todo = sample.filter((s) => !doneIds.has(s.id)).slice(0, BATCH);
    console.log(`[loop-b] ${doneIds.size}/${sample.length} already done; running ${todo.length} this batch`);
    if (!todo.length) { console.log('[loop-b] ALL DONE'); process.exit(0); }

    let idx = 0;
    const write = () => fs.writeFileSync(OUT, JSON.stringify({ meta: { model: MODEL, judge_model: JUDGE_MODEL, updated: new Date().toISOString(), n: done.length }, results: done }, null, 1));
    async function worker() {
        while (idx < todo.length) {
            const item = todo[idx++];
            try { done.push(await runItem(item)); } catch (e) { done.push({ id: item.id, category: item.category, fatal_error: String(e.message) }); }
            write();
            console.log(`[loop-b] ${done.length}/${sample.length} (last: ${item.id})`);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    write();
    console.log(`[loop-b] batch complete. total ${done.length}/${sample.length}`);
    process.exit(0);
}

main();

'use strict';
/*
 * WINE AI — adaptive routing A/B experiment (RESEARCH ONLY, read-only vs staging).
 *
 * Condition A "direct": real persona/voice-style system instruction from
 *   src/realtime/realtimePrompt.js, NO tools -> model answers from priors.
 * Condition B "rag": real production tool impl from
 *   src/tools/searchLayeredKnowledge.js (-> routeKnowledgeWithAnswerabilityGate),
 *   result fed back as a functionResponse part exactly like the voice pipeline,
 *   same persona system instruction.
 *
 * Never writes to Postgres (db.init() is deliberately NOT called).
 */

if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { buildRealtimeSystemInstruction } = require('../../src/realtime/realtimePrompt');
const searchWineKnowledge = require('../../src/tools/searchLayeredKnowledge');

const MODEL = process.env.EXP_MODEL || 'gemini-2.5-flash';
const JUDGE_MODEL = process.env.EXP_JUDGE_MODEL || 'gemini-2.5-flash';
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY || 3);
const LIMIT = Number(process.env.EXP_LIMIT || 0);
const OUT = path.join(__dirname, 'results.json');

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
    const parts = res?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('').trim();
}

function usageOf(res) {
    const u = res?.usageMetadata;
    return u ? {
        prompt_tokens: u.promptTokenCount ?? null,
        output_tokens: u.candidatesTokenCount ?? null,
        total_tokens: u.totalTokenCount ?? null,
    } : null;
}

async function withRetry(fn, label, tries = 8) {
    let last;
    for (let i = 0; i < tries; i += 1) {
        try { return await fn(); } catch (e) {
            last = e;
            const msg = String(e?.message || '');
            if (!/429|503|500|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONN/i.test(msg)) break;
            await new Promise((r) => setTimeout(r, 12000 * (i + 1) + Math.random() * 6000));
        }
    }
    throw new Error(`${label}: ${last?.message || 'unknown'}`);
}

async function generate({ system, contents }) {
    return withRetry(() => ai.models.generateContent({
        model: MODEL,
        contents,
        config: { systemInstruction: system, temperature: 0.6, maxOutputTokens: 900 },
    }), 'generate');
}

// ---- condition A: direct (no retrieval) --------------------------------
async function runDirect(question, history) {
    const contents = [];
    for (const h of history) {
        contents.push({ role: 'user', parts: [{ text: h.q }] });
        contents.push({ role: 'model', parts: [{ text: h.a }] });
    }
    contents.push({ role: 'user', parts: [{ text: question }] });
    const t0 = Date.now();
    const res = await generate({ system: sysInstruction(history.flatMap((h) => ([{ role: 'user', text: h.q }, { role: 'assistant', text: h.a }]))), contents });
    return {
        answer: textOf(res),
        latency_ms: Date.now() - t0,
        usage: usageOf(res),
    };
}

// ---- condition B: production RAG path -----------------------------------
async function runRag(question, history, lang) {
    const t0 = Date.now();
    let tool;
    try {
        tool = await searchWineKnowledge.impl({ query: question, language: lang }, {});
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
    const res = await generate({ system: sysInstruction(history.flatMap((h) => ([{ role: 'user', text: h.q }, { role: 'assistant', text: h.a }]))), contents });
    const generation_ms = Date.now() - t1;
    return {
        answer: textOf(res),
        latency_ms: retrieval_ms + generation_ms,
        retrieval_ms,
        generation_ms,
        usage: usageOf(res),
        retrieval: {
            found: tool.found === true,
            answerable: tool.answerable ?? null,
            answerability_reason: tool.answerabilityReason || null,
            claim_class: tool.claimClass || null,
            entity_match: tool.entityMatch || null,
            status: tool.status || null,
            web_used: tool.webUsed === true,
            web_reason: tool.webReason || null,
            used_levels: tool.used_levels || [],
            evidence: (tool.evidence || []).slice(0, 8).map((e) => ({
                level: e.level, title: e.title || null, source: e.source || null,
                confidence: e.confidence || null, text: String(e.text || '').slice(0, 700),
            })),
        },
    };
}

// ---- judge ---------------------------------------------------------------
const JUDGE_SCHEMA = {
    type: 'object',
    properties: {
        direct: {
            type: 'object',
            properties: {
                quality: { type: 'integer' }, factuality: { type: 'integer' },
                relevance: { type: 'integer' }, naturalness: { type: 'integer' },
                unverified_specific_claims: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
            },
            required: ['quality', 'factuality', 'relevance', 'naturalness', 'unverified_specific_claims', 'notes'],
        },
        rag: {
            type: 'object',
            properties: {
                quality: { type: 'integer' }, factuality: { type: 'integer' },
                relevance: { type: 'integer' }, naturalness: { type: 'integer' },
                unverified_specific_claims: { type: 'array', items: { type: 'string' } },
                notes: { type: 'string' },
            },
            required: ['quality', 'factuality', 'relevance', 'naturalness', 'unverified_specific_claims', 'notes'],
        },
        grounding_necessary: { type: 'boolean' },
        grounding_necessary_reason: { type: 'string' },
        retrieval_effect: { type: 'string', enum: ['helped', 'neutral', 'harmed'] },
        retrieval_effect_kind: {
            type: 'string',
            enum: ['none', 'irrelevant_facts_added', 'answer_derailed', 'contradiction_introduced', 'heavier_without_benefit', 'refused_though_answerable', 'added_verified_specifics', 'prevented_hallucination'],
        },
        retrieval_effect_explanation: { type: 'string' },
        verdict: { type: 'string', enum: ['DIRECT_SUFFICIENT', 'GROUNDING_REQUIRED', 'AMBIGUOUS'] },
    },
    required: ['direct', 'rag', 'grounding_necessary', 'grounding_necessary_reason', 'retrieval_effect', 'retrieval_effect_kind', 'retrieval_effect_explanation', 'verdict'],
};

function judgePrompt(item, question, direct, rag) {
    const ev = (rag.retrieval?.evidence || []).map((e, i) => `[${i + 1}] (${e.level}/${e.confidence}) ${e.title || ''}\n${e.text}`).join('\n\n') || '(no evidence retrieved)';
    return `Ты строгий эксперт-оценщик для голосового ИИ-сомелье "WINE AI" (проект о молдавском вине, работает на собственной базе знаний + каталог + веб).

Оцени ДВА ответа на один и тот же вопрос пользователя.
- Ответ A ("direct") сгенерирован БЕЗ доступа к базе знаний, только из знаний модели.
- Ответ B ("rag") сгенерирован ПОСЛЕ поиска в собственной базе WINE AI; ниже приведены реально извлечённые фрагменты.

Оценивай по шкале 1-5 (5 — отлично):
- quality: полезность и полнота ответа для пользователя
- factuality: фактическая корректность и отсутствие выдуманных деталей. КРИТИЧНО: если ответ уверенно называет конкретный факт (цену, год урожая, крепость, тираж, имя винодела, награду, часы работы), который НЕ подтверждается фрагментами и не является общеизвестным — factuality не выше 2.
- relevance: отвечает ли именно на заданный вопрос
- naturalness: живая разговорная речь, подходящая для голосового ассистента

Также:
- unverified_specific_claims: список конкретных непроверяемых/выдуманных утверждений в этом ответе (цены, годы, проценты, названия продуктов, награды, имена). Пустой массив, если таких нет.
- grounding_necessary: были ли СОБСТВЕННЫЕ данные WINE AI действительно необходимы, чтобы ответить на этот вопрос хорошо?
- retrieval_effect: помог ли извлечённый контекст ("helped"), не изменил ничего существенного ("neutral") или ухудшил ответ ("harmed")?
- retrieval_effect_kind: конкретный характер эффекта.
- verdict: DIRECT_SUFFICIENT / GROUNDING_REQUIRED / AMBIGUOUS.

ВОПРОС: ${question}
${item.turns ? `(это второй ход диалога; первый ход: "${item.turns[0]}")` : ''}

ОТВЕТ A (direct):
${direct.answer || '(пусто)'}

ИЗВЛЕЧЁННЫЕ ФРАГМЕНТЫ (для ответа B):
${ev}

ОТВЕТ B (rag):
${rag.answer || '(пусто)'}

Верни строгий JSON по схеме.`;
}

async function judge(item, question, direct, rag) {
    const res = await withRetry(() => ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: judgePrompt(item, question, direct, rag) }] }],
        config: {
            temperature: 0,
            maxOutputTokens: 1200,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: 'application/json',
            responseSchema: JUDGE_SCHEMA,
        },
    }), 'judge');
    const raw = textOf(res);
    try { return JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw); } catch { return { parse_error: true, raw: raw.slice(0, 800) }; }
}

// ---- driver --------------------------------------------------------------
async function runItem(item) {
    const out = { id: item.id, class: item.class, prior: item.prior, lang: item.lang, steps: [] };
    const history = [];
    const turns = item.turns || [item.text];
    for (let i = 0; i < turns.length; i += 1) {
        const q = turns[i];
        const [direct, rag] = await Promise.all([
            runDirect(q, history).catch((e) => ({ answer: '', error: String(e.message), latency_ms: null, usage: null })),
            runRag(q, history, item.lang).catch((e) => ({ answer: '', error: String(e.message), latency_ms: null, usage: null, retrieval: null })),
        ]);
        const graded = (direct.answer && rag.answer) ? await judge(item, q, direct, rag).catch((e) => ({ error: String(e.message) })) : { skipped: 'missing_answer' };
        out.steps.push({ turn: i + 1, question: q, direct, rag, judge: graded });
        // Multi-turn context uses the RAG answer as the canonical conversation
        // history for BOTH conditions, so turn 2 differs only in retrieval.
        history.push({ q, a: rag.answer || direct.answer || '' });
    }
    return out;
}

async function main() {
    const ds = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
    let items = ds.questions;
    if (LIMIT) items = items.slice(0, LIMIT);
    const results = [];
    let idx = 0;
    let done = 0;
    async function worker() {
        while (idx < items.length) {
            const item = items[idx++];
            try {
                results.push(await runItem(item));
            } catch (e) {
                results.push({ id: item.id, class: item.class, prior: item.prior, fatal_error: String(e.message) });
            }
            done += 1;
            if (done % 5 === 0) console.log(`[progress] ${done}/${items.length}`);
            fs.writeFileSync(OUT, JSON.stringify({ meta: { model: MODEL, judge_model: JUDGE_MODEL, started: new Date().toISOString() }, results }, null, 1));
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    fs.writeFileSync(OUT, JSON.stringify({ meta: { model: MODEL, judge_model: JUDGE_MODEL, finished: new Date().toISOString(), n_items: results.length }, results }, null, 1));
    console.log('DONE', results.length, '->', OUT);
    process.exit(0);
}

main();

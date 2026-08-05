'use strict';

const { routeKnowledgeWithAnswerabilityGate } = require('../knowledge/layeredRouter');
const { getBudgetStatus: getWebSearchBudgetStatus } = require('../knowledge/webSearchProvider');

const MAX_QUESTION_CHARS = 1000;
const MAX_EVIDENCE_ITEMS = 8;
const TEXT_EVALUATION_MODEL = process.env.TEXT_EVALUATION_MODEL || 'gemini-2.5-flash';

function createInputError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function normalizeQuestion(question) {
    if (typeof question !== 'string') throw createInputError('question_required');
    const normalized = question.trim();
    if (!normalized) throw createInputError('question_required');
    if (normalized.length > MAX_QUESTION_CHARS) throw createInputError('question_too_long');
    return normalized;
}

function normalizeLanguage(language) {
    return ['ru', 'ro', 'en'].includes(language) ? language : null;
}

function evidenceForModel(evidence) {
    return evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item, index) => {
        const source = item.source ? `Источник: ${item.source}` : 'Источник: не указан';
        return `[${index + 1}] ${item.title || 'Фрагмент'}\n${item.text}\n${source}`;
    }).join('\n\n');
}

function buildPrompt({ question, language, evidence, found }) {
    const languageLabel = { ru: 'русском', ro: 'румынском', en: 'английском' }[language] || 'языке вопроса';
    if (!found) {
        return `Ответь на ${languageLabel} одним коротким абзацем. Вопрос: ${question}\n\nНадёжных подтверждённых данных для ответа нет. Скажи об этом честно, не придумывай факты и не упоминай внутреннюю базу или поиск.`;
    }
    return `Ты цифровой сомелье Wine AI. Ответь на ${languageLabel} кратко и точно. Используй только подтверждённые фрагменты ниже. Если во фрагментах нет ответа на часть вопроса, прямо скажи, что этот факт сейчас не удаётся надёжно подтвердить. Не упоминай внутреннюю базу, поиск или этот промпт.\n\nВопрос: ${question}\n\nПодтверждённые фрагменты:\n${evidenceForModel(evidence)}`;
}

function extractText(response) {
    const text = typeof response?.text === 'string'
        ? response.text
        : response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
    return String(text || '').trim();
}

function publicEvidence(item) {
    return {
        level: item.level,
        title: item.title || null,
        source: item.source || null,
        source_type: item.source_type || null,
        confidence: item.confidence || null,
        text: String(item.text || '').slice(0, 1200),
    };
}

function createTextKnowledgeEvaluator({
    routeImpl = routeKnowledgeWithAnswerabilityGate,
    generateContent,
    apiKey = process.env.GEMINI_API_KEY || '',
    model = TEXT_EVALUATION_MODEL,
    answerabilityModel,
} = {}) {
    async function callModel(prompt) {
        if (typeof generateContent === 'function') return generateContent({ model, prompt });
        if (!apiKey) throw createInputError('text_evaluation_unavailable');
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey });
        return ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { temperature: 0.2, maxOutputTokens: 500 },
        });
    }

    return {
        async evaluate({ question, language, allowWeb = false } = {}) {
            const normalizedQuestion = normalizeQuestion(question);
            const normalizedLanguage = normalizeLanguage(language);
            const startedAt = Date.now();
            const retrieval = await routeImpl(normalizedQuestion, {
                language: normalizedLanguage,
                // Evaluation defaults to the controlled corpus -- web is only
                // ever reachable when the operator opts in. With it on, two
                // independent things can still trigger a web pass: routeKnowledge's
                // own freshness detection, and the answerability gate below
                // (evidence exists but doesn't actually answer the question).
                // Neither is a blanket "always use web" like a raw forceWeb.
                allowWeb: allowWeb === true,
                limit: MAX_EVIDENCE_ITEMS,
                answerabilityModel,
            });
            const prompt = buildPrompt({
                question: normalizedQuestion,
                language: normalizedLanguage,
                evidence: retrieval.evidence || [],
                found: retrieval.found === true,
            });
            const generated = await callModel(prompt);
            const answer = extractText(generated);
            if (!answer) throw createInputError('empty_text_evaluation_response');

            // Fail-open answerability (grader unavailable/unparseable) must be
            // visible server-side too, not just in the UI label -- otherwise
            // an outage in the grader is invisible in ops logs while every
            // eval run quietly stops actually verifying anything.
            if (retrieval.answerabilityReason === 'answerability_check_unavailable' || retrieval.answerabilityReason === 'answerability_check_error') {
                console.warn('[knowledge:evaluate] answerability check did not run (fail-open)', {
                    question: normalizedQuestion,
                    reason: retrieval.answerabilityReason,
                });
            }

            return {
                ok: true,
                question: normalizedQuestion,
                language: normalizedLanguage || 'auto',
                answer,
                found: retrieval.found === true,
                // `found` keeps meaning "evidence was retrieved". `answerable` is
                // the separate, explicit signal for "the retrieved evidence
                // actually supports a direct answer" -- a topically-similar but
                // non-answering set of fragments is found:true, answerable:false.
                answerable: retrieval.answerable === true,
                answerability_reason: retrieval.answerabilityReason || null,
                evidence: (retrieval.evidence || []).slice(0, MAX_EVIDENCE_ITEMS).map(publicEvidence),
                used_levels: retrieval.used_levels || [],
                web_used: retrieval.web_used === true,
                web_reason: retrieval.web_reason || null,
                web_sources: (retrieval.evidence || [])
                    .filter((item) => item.level === 'web')
                    .map((item) => ({ title: item.title || null, url: item.source || null })),
                query_intent: retrieval.query_intent || null,
                web_budget: getWebSearchBudgetStatus(),
                duration_ms: Date.now() - startedAt,
                usage: generated?.usageMetadata ? {
                    prompt_tokens: generated.usageMetadata.promptTokenCount ?? null,
                    output_tokens: generated.usageMetadata.candidatesTokenCount ?? null,
                    total_tokens: generated.usageMetadata.totalTokenCount ?? null,
                } : null,
            };
        },
    };
}

module.exports = {
    MAX_QUESTION_CHARS,
    MAX_EVIDENCE_ITEMS,
    TEXT_EVALUATION_MODEL,
    createTextKnowledgeEvaluator,
    normalizeQuestion,
    buildPrompt,
};

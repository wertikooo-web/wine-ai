'use strict';

// Model-facing size budget for knowledge tool results (Gemini Live / Grok).
//
// Production cost audit 2026-10-01: one search_wine_knowledge result was
// 49-167K chars (~15-45K tokens) -- the same fragments sent up to four times
// (evidence, results, claims, inference.claims) -- and every tool result
// stays in the realtime context, which the provider re-bills on EVERY later
// turn. This compacts only what the model receives; the tool itself, its
// gates, links/cards (emitted inside the tools) and every server-side
// consumer keep the full result.
//
// Never shortened: instructions/rules/guidance, status flags, URLs,
// operator news. Shortened: duplicate lists, provenance/scoring internals,
// fragment counts and fragment text length.

const DEFAULT_BUDGET_CHARS = 9000;

// fetch_page returns a page for the model to read on purpose: untouched.
// Every other tool is compacted only when over budget (small results such as
// show_links/search_place never are).
const PASSTHROUGH_TOOLS = new Set(['fetch_page']);

// Internal scoring/provenance, never needed to word an answer.
const DROP_KEYS = new Set(['provenance', 'relevance_score', '_conflict_key', 'embedding', 'source_type', 'structured']);
// Strings the model must receive verbatim.
const PROTECTED_KEY_RE = /instruction|guidance|rules|policy|tone|error|message|status|answer_mode|scenario|url/i;
// Subtrees passed through verbatim (the instruction says "add nothing beyond its text").
const VERBATIM_KEYS = new Set(['operator_news', 'answer_policy', 'rules']);
// Short reason/caveat lines: kept (they carry "price not confirmed" caveats).
const LINE_LIST_KEYS = new Set(['explanation', 'missing']);
// Lists of recommended items: generous cap so counts in the text match.
const ITEM_LIST_KEYS = new Set(['stops', 'wines', 'candidates', 'bottles', 'webSources']);
// Element key a list's items are compacted as.
const ITEM_KEY = { evidence: 'evidence_item', claims: 'claim_item' };

// Claim kinds by how much the narrator may rely on them.
const KIND_RANK = { verified_fact: 0, live_catalog_fact: 1, current_web_fact: 2, unresolved_or_conflicting: 2, document_supported_fact: 3 };

function capsFor(level) {
    return level === 0
        ? { evidence: 5, claims: 5, list: 6, text: 700, claim: 260, string: 400 }
        : { evidence: 4, claims: 4, list: 5, text: 450, claim: 180, string: 260 };
}

function trimString(value, max) {
    const s = String(value);
    return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

function isEmpty(value) {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false;
}

function compactValue(value, key, caps, depth) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (PROTECTED_KEY_RE.test(key) || /^https?:\/\//.test(value)) return value;
        if (key === 'text') return trimString(value, caps.text);
        if (key === 'claim' || key === 'value') return trimString(value, caps.claim);
        return trimString(value, caps.string);
    }
    if (Array.isArray(value)) {
        if (LINE_LIST_KEYS.has(key)) return value.slice(0, 12).map((s) => (typeof s === 'string' ? trimString(s, 300) : s));
        let limit = caps.list;
        if (key === 'evidence') limit = caps.evidence;
        else if (key === 'claims') limit = caps.claims;
        else if (ITEM_LIST_KEYS.has(key)) limit = 8;
        const itemKey = ITEM_KEY[key] || key;
        return value.slice(0, limit).map((item) => compactValue(item, itemKey, caps, depth + 1));
    }
    if (typeof value === 'object') {
        // Deeper than any real tool output: keep it rather than lose it.
        if (depth > 8) return value;
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (DROP_KEYS.has(k)) continue;
            if (VERBATIM_KEYS.has(k)) { out[k] = v; continue; }
            // A claim's source is reduced to what a spoken answer can use.
            if (k === 'source' && v && typeof v === 'object' && !Array.isArray(v)) {
                const src = {};
                if (v.title) src.title = trimString(v.title, 80);
                if (v.url) src.url = v.url;
                if (Object.keys(src).length) out.source = src;
                continue;
            }
            // Filler: unset values and a non-dynamic freshness stamp.
            if (isEmpty(v)) continue;
            if (k === 'freshness' && v && typeof v === 'object' && v.dynamic === false && !v.as_of) continue;
            const next = compactValue(v, k, caps, depth + 1);
            if (!isEmpty(next)) out[k] = next;
        }
        return out;
    }
    return value;
}

function lower(value) {
    return String(value || '').toLowerCase();
}

// inference.claims are the facts the narrator may quote about the
// recommendation: keep the ones about the recommended items first, then by
// claim kind; never by position (relations come first in the raw order).
function pickInferenceClaims(inference, n) {
    const inner = inference.inference || {};
    const names = [
        ...(inner.wines || []).map((w) => w && w.name),
        ...(inner.candidates || []).flatMap((c) => [c && c.style_name, ...((c && c.bottles) || []).map((b) => (typeof b === 'string' ? b : b && b.name))]),
        ...(inner.stops || []).map((s) => s && s.name),
    ].filter(Boolean).map(lower);
    const mentions = (c) => names.some((name) => `${lower(c.claim)} ${lower(c.source && c.source.title)}`.includes(name));
    return (inference.claims || [])
        .filter((c) => c && c.kind !== 'ai_inference')
        .map((c, i) => ({ c, i, s: (mentions(c) ? 0 : 10) + (KIND_RANK[c.kind] ?? 5) }))
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .slice(0, n)
        .map((o) => o.c);
}

function rankEvidence(evidence) {
    const LEVEL_RANK = { canonical: 0, relations: 0, catalog: 1, documents: 2, web: 2 };
    return evidence
        .map((e, i) => ({ e, i, s: LEVEL_RANK[e && e.level] ?? 3 }))
        .sort((a, b) => a.s - b.s || a.i - b.i)
        .map((o) => o.e);
}

function compactOnce(result, level) {
    const caps = capsFor(level);
    const copy = { ...result };
    // `results` duplicates `evidence` byte for byte.
    if (Array.isArray(copy.results) && Array.isArray(copy.evidence)) delete copy.results;
    if (Array.isArray(copy.evidence)) copy.evidence = rankEvidence(copy.evidence);
    // Top-level claims repeat the evidence text; only conflicts add anything.
    if (Array.isArray(copy.claims) && Array.isArray(copy.evidence) && copy.evidence.length) {
        copy.claims = copy.claims.filter((c) => c && c.conflict);
    }
    if (copy.inference && typeof copy.inference === 'object' && Array.isArray(copy.inference.claims)) {
        copy.inference = { ...copy.inference, claims: pickInferenceClaims(copy.inference, caps.claims) };
    }
    // The recovery instruction is repeated verbatim in answer_policy.
    if (copy.recovery && copy.answer_policy && copy.recovery.final_instruction
        && copy.recovery.final_instruction === copy.answer_policy.final_instruction) {
        const { final_instruction: _dup, ...rest } = copy.recovery;
        copy.recovery = rest;
    }
    return compactValue(copy, '', caps, 0);
}

// Returns { result, beforeChars, afterChars, compacted }.
function compactToolResultForModel(result, { budgetChars = DEFAULT_BUDGET_CHARS } = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return { result, compacted: false };
    try {
        const beforeChars = JSON.stringify(result).length;
        if (beforeChars <= budgetChars) return { result, beforeChars, afterChars: beforeChars, compacted: false };
        let out = compactOnce(result, 0);
        let afterChars = JSON.stringify(out).length;
        if (afterChars > budgetChars) {
            out = compactOnce(result, 1);
            afterChars = JSON.stringify(out).length;
        }
        return { result: out, beforeChars, afterChars, compacted: true };
    } catch {
        // Never break a tool turn over a budget pass.
        return { result, compacted: false };
    }
}

function toolResultBudgetConfig(env = process.env) {
    const mode = String(env.TOOL_RESULT_COMPACT || 'on').toLowerCase();
    const budget = Number(env.TOOL_RESULT_BUDGET_CHARS);
    return { enabled: mode !== 'off', budgetChars: Number.isFinite(budget) && budget >= 2000 ? budget : DEFAULT_BUDGET_CHARS };
}

// Wraps tool handlers so only the model-facing results are compacted.
function wrapToolHandlersWithBudget(handlers, { config = toolResultBudgetConfig(), onCompacted = null } = {}) {
    if (!config.enabled || !handlers || typeof handlers !== 'object') return handlers;
    const wrapped = { ...handlers };
    for (const [name, handler] of Object.entries(handlers)) {
        if (PASSTHROUGH_TOOLS.has(name) || typeof handler !== 'function') continue;
        wrapped[name] = async (call) => {
            const raw = await handler(call);
            const out = compactToolResultForModel(raw, { budgetChars: config.budgetChars });
            if (out.compacted && typeof onCompacted === 'function') {
                try { onCompacted({ tool: name, beforeChars: out.beforeChars, afterChars: out.afterChars }); } catch { /* logging only */ }
            }
            return out.result;
        };
    }
    return wrapped;
}

module.exports = { compactToolResultForModel, wrapToolHandlersWithBudget, toolResultBudgetConfig, pickInferenceClaims, DEFAULT_BUDGET_CHARS, PASSTHROUGH_TOOLS };

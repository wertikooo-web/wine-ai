'use strict';

// Prompt-assembly mechanism, kept generic/transport-side. Persona *content*
// lives in src/persona/wineExpertPersona.js and is only ever pulled in here
// as a default — this module has no domain knowledge of wine.
const crypto = require('crypto');
const { defaultPersonaPrompt } = require('../persona/wineExpertPersona');

// Generous ceiling per block, mirroring the reasoning that produced this
// same kind of constant in the origin project: must comfortably fit a
// full persona prompt plus a dashboard-supplied override, and UTF-8
// Cyrillic/Romanian-diacritic text runs close to 2 bytes/char.
const PROMPT_MAX_CHARS = Math.max(1000, Number(process.env.PROMPT_MAX_CHARS || 24000));
const DASHBOARD_ALLOW_CUSTOM_PROMPT = /^(1|true|yes)$/i.test(String(process.env.DASHBOARD_ALLOW_CUSTOM_PROMPT || ''));

function normalizeBlock(value) {
    return String(value || '').trim();
}

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

function blockMeta(text) {
    const normalized = normalizeBlock(text);
    return {
        chars: normalized.length,
        hash: hashText(normalized),
    };
}

function requireWithinLimit(text, label, maxChars = PROMPT_MAX_CHARS) {
    const normalized = normalizeBlock(text);
    if (normalized.length > maxChars) {
        const error = new Error(`${label}_too_long`);
        error.code = `${label}_too_long`;
        error.maxChars = maxChars;
        error.chars = normalized.length;
        throw error;
    }
    return normalized;
}

function buildCurrentContext(currentContext = {}) {
    const now = currentContext.now ? new Date(currentContext.now) : new Date();
    const turns = Array.isArray(currentContext.recentTurns) ? currentContext.recentTurns.slice(-6) : [];
    const lines = [
        `Current date/time: ${normalizeBlock(currentContext.localDateTime) || (Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString())}`,
        `Session language: ${normalizeBlock(currentContext.sessionLanguage) || 'auto'}`,
    ];
    if (currentContext.languageInstruction) {
        lines.push(normalizeBlock(currentContext.languageInstruction));
    }
    if (currentContext.sessionMemory) {
        lines.push('Session memory (this conversation only):', normalizeBlock(currentContext.sessionMemory));
    }
    lines.push(
        `Mode: ${normalizeBlock(currentContext.mode || 'push_to_talk')}`,
        'Recent turns:',
    );

    if (turns.length === 0) {
        lines.push('- none yet this session');
    } else {
        turns.forEach((turn) => {
            const role = normalizeBlock(turn.role || 'unknown').slice(0, 16);
            const text = normalizeBlock(turn.text).slice(0, 240);
            if (text) lines.push(`- ${role}: ${text}`);
        });
    }

    return lines.join('\n');
}

function buildRealtimeSystemInstruction({
    persona,
    currentContext,
} = {}) {
    const personaBlock = requireWithinLimit(persona || defaultPersonaPrompt(), 'persona');
    const current = requireWithinLimit(
        typeof currentContext === 'string' ? currentContext : buildCurrentContext(currentContext),
        'current_context',
    );
    const text = [
        '[PERSONA]',
        personaBlock,
        '',
        '[CURRENT CONTEXT]',
        current,
    ].join('\n');

    return {
        text,
        blocks: {
            persona: personaBlock,
            currentContext: current,
        },
        meta: {
            promptChars: text.length,
            promptHash: hashText(text),
            persona: blockMeta(personaBlock),
            currentContext: blockMeta(current),
        },
    };
}

function defaultPromptBlocks() {
    return {
        persona: defaultPersonaPrompt(),
    };
}

function sanitizePromptConfig(config = {}, { allowCustomPrompt = DASHBOARD_ALLOW_CUSTOM_PROMPT } = {}) {
    const source = allowCustomPrompt ? 'dashboard' : 'default';
    if (!allowCustomPrompt) {
        return {
            source,
            blocks: defaultPromptBlocks(),
        };
    }

    return {
        source,
        blocks: {
            persona: requireWithinLimit(config.persona || defaultPersonaPrompt(), 'persona'),
        },
    };
}

module.exports = {
    PROMPT_MAX_CHARS,
    DASHBOARD_ALLOW_CUSTOM_PROMPT,
    buildCurrentContext,
    buildRealtimeSystemInstruction,
    defaultPromptBlocks,
    sanitizePromptConfig,
    hashText,
};

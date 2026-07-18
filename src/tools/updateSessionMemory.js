'use strict';

// Sixth, optional tool beyond the five minimum ones (see docs/ARCHITECTURE.md
// and AGENTS.md) — lets the model explicitly record structured session facts
// (see src/memory/sessionMemory.js) instead of them only living as raw
// recent-turn text. Never writes anything outside the current session.

const declaration = {
    name: 'update_session_memory',
    description: 'Record a structured fact about this conversation only (a wine discussed, a stated preference, a disliked style, budget, occasion, or planned dish). Call this when the user clearly states one of these, not for every turn.',
    parameters: {
        type: 'OBJECT',
        properties: {
            discussedWine: { type: 'STRING', description: 'Name of a wine or grape variety just discussed.' },
            preference: { type: 'STRING', description: 'A stated preference (e.g. "prefers dry reds").' },
            dislikedStyle: { type: 'STRING', description: 'A stated dislike (e.g. "does not like sweet wine").' },
            budget: { type: 'STRING', description: 'A stated budget hint.' },
            occasion: { type: 'STRING', description: 'The occasion for the wine (e.g. anniversary dinner).' },
        },
    },
};

async function impl(args, toolContext = {}) {
    const memory = toolContext.sessionMemory;
    if (!memory) return { recorded: false, reason: 'session_memory_unavailable' };

    const recorded = [];
    if (args.discussedWine) { memory.recordDiscussedWine(args.discussedWine); recorded.push('discussedWine'); }
    if (args.preference) { memory.recordPreference(args.preference); recorded.push('preference'); }
    if (args.dislikedStyle) { memory.recordDislikedStyle(args.dislikedStyle); recorded.push('dislikedStyle'); }
    if (args.budget) { memory.setBudget(args.budget); recorded.push('budget'); }
    if (args.occasion) { memory.setOccasion(args.occasion); recorded.push('occasion'); }

    return { recorded: recorded.length > 0, fields: recorded };
}

module.exports = { declaration, impl };

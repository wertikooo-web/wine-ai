'use strict';

// Simple in-memory state for one demo session — see docs/ARCHITECTURE.md
// and AGENTS.md's memory section. No persistence across sessions/users and
// no Postgres in v1 (see docs/WINE_AI_MIGRATION_PLAN.md section 1.17 on why
// the origin project's Postgres memory schema was not carried over). Never
// stores audio or personal data — only wine-domain facts and preferences
// the user volunteered in this conversation.

const MAX_DISCUSSED_WINES = 20;
const MAX_PREFERENCES = 20;
const MAX_TEXT_CHARS = 200;

function clip(value) {
    return String(value || '').trim().slice(0, MAX_TEXT_CHARS);
}

function createSessionMemory() {
    const state = {
        discussedWines: [],
        preferences: [],
        dislikedStyles: [],
        budget: null,
        occasion: null,
        plannedDish: null,
        tastingContext: null,
        // Phase 4: Conversation context for follow-up resolution
        activeEntityId: null,
        activeEntityName: null,
        activeEntityType: null,
        activeWineId: null,
        activeWineName: null,
        lastIntent: null,
        lastToolResult: null,
        lastReferencedEntityType: null,
    };

    function recordDiscussedWine(name) {
        const clean = clip(name);
        if (!clean) return;
        if (!state.discussedWines.includes(clean)) {
            state.discussedWines.push(clean);
            if (state.discussedWines.length > MAX_DISCUSSED_WINES) state.discussedWines.shift();
        }
    }

    function recordPreference(preference) {
        const clean = clip(preference);
        if (!clean) return;
        if (!state.preferences.includes(clean)) {
            state.preferences.push(clean);
            if (state.preferences.length > MAX_PREFERENCES) state.preferences.shift();
        }
    }

    function recordDislikedStyle(style) {
        const clean = clip(style);
        if (!clean) return;
        if (!state.dislikedStyles.includes(clean)) state.dislikedStyles.push(clean);
    }

    function setBudget(budget) {
        state.budget = clip(budget) || null;
    }

    function setOccasion(occasion) {
        state.occasion = clip(occasion) || null;
    }

    // Convenience hook used by src/tools/recommendWinePairing.js — folds a
    // pairing request into occasion/plannedDish/budget without requiring a
    // separate tool call for something the model already told us directly.
    function recordPairingRequest({ dish, occasion, budget } = {}) {
        if (dish) state.plannedDish = clip(dish);
        if (occasion) state.occasion = clip(occasion);
        if (budget) state.budget = clip(budget);
    }

    function setTastingContext(context) {
        state.tastingContext = clip(context) || null;
    }

    // Phase 4: Conversation context setters
    function setActiveEntity(entityId, entityName, entityType) {
        state.activeEntityId = clip(entityId) || null;
        state.activeEntityName = clip(entityName) || null;
        state.activeEntityType = clip(entityType) || null;
    }

    function setActiveWine(wineId, wineName) {
        state.activeWineId = clip(wineId) || null;
        state.activeWineName = clip(wineName) || null;
    }

    function setLastIntent(intent) {
        state.lastIntent = clip(intent) || null;
    }

    function setLastToolResult(result) {
        state.lastToolResult = clip(JSON.stringify(result)) || null;
    }

    function setLastReferencedEntityType(entityType) {
        state.lastReferencedEntityType = clip(entityType) || null;
    }

    function getActiveEntity() {
        return {
            id: state.activeEntityId,
            name: state.activeEntityName,
            type: state.activeEntityType,
        };
    }

    function getActiveWine() {
        return {
            id: state.activeWineId,
            name: state.activeWineName,
        };
    }

    // Renders a short block for [CURRENT CONTEXT] — omits empty fields
    // entirely rather than printing "none" noise into every prompt.
    function formatForPrompt() {
        const lines = [];
        if (state.discussedWines.length) lines.push(`Wines discussed: ${state.discussedWines.join(', ')}`);
        if (state.preferences.length) lines.push(`Stated preferences: ${state.preferences.join(', ')}`);
        if (state.dislikedStyles.length) lines.push(`Disliked styles: ${state.dislikedStyles.join(', ')}`);
        if (state.budget) lines.push(`Budget: ${state.budget}`);
        if (state.occasion) lines.push(`Occasion: ${state.occasion}`);
        if (state.plannedDish) lines.push(`Planned dish: ${state.plannedDish}`);
        if (state.tastingContext) lines.push(`Tasting context: ${state.tastingContext}`);
        // Phase 4: Conversation context for follow-up resolution
        if (state.activeEntityId) lines.push(`Active entity: ${state.activeEntityName || state.activeEntityId} (type: ${state.activeEntityType || 'unknown'})`);
        if (state.activeWineId) lines.push(`Active wine: ${state.activeWineName || state.activeWineId}`);
        if (state.lastIntent) lines.push(`Last intent: ${state.lastIntent}`);
        return lines.length ? lines.join('\n') : null;
    }

    function snapshot() {
        return JSON.parse(JSON.stringify(state));
    }

    return {
        recordDiscussedWine,
        recordPreference,
        recordDislikedStyle,
        setBudget,
        setOccasion,
        recordPairingRequest,
        setTastingContext,
        setActiveEntity,
        setActiveWine,
        setLastIntent,
        setLastToolResult,
        setLastReferencedEntityType,
        getActiveEntity,
        getActiveWine,
        formatForPrompt,
        snapshot,
    };
}

module.exports = { createSessionMemory };

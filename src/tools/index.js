'use strict';

const { bindTool } = require('./toolHelpers');
const searchWineKnowledge = require('./searchWineKnowledge');
const searchWinery = require('./searchWinery');
const compareGrapeVarieties = require('./compareGrapeVarieties');
const recommendWinePairing = require('./recommendWinePairing');
const getWineRouteInformation = require('./getWineRouteInformation');
const updateSessionMemory = require('./updateSessionMemory');
const checkWineMdAvailability = require('./checkWineMdAvailability');

const TOOLS = [
    searchWineKnowledge,
    searchWinery,
    compareGrapeVarieties,
    recommendWinePairing,
    getWineRouteInformation,
    updateSessionMemory,
    checkWineMdAvailability,
];

// Static schema list for Gemini Live's `tools: [{ functionDeclarations }]`
// — safe to share across sessions (see src/realtime/geminiLiveProvider.js's
// buildLiveTools()).
const TOOL_DECLARATIONS = TOOLS.map((tool) => tool.declaration);

// Per-session handler map — bound to that session's own sessionMemory/log,
// matching the factory contract src/realtime/realtimeServer.js expects
// (providerMetadata.createToolHandlers({ sessionMemory, log })).
function createToolHandlers(toolContext) {
    const handlers = {};
    for (const tool of TOOLS) {
        handlers[tool.declaration.name] = bindTool({ name: tool.declaration.name, impl: tool.impl }, toolContext);
    }
    return handlers;
}

module.exports = {
    TOOL_DECLARATIONS,
    createToolHandlers,
};

'use strict';

const { bindTool } = require('./toolHelpers');
const searchWineKnowledge = require('./searchLayeredKnowledge');
const searchWinery = require('./searchWinery');
const compareGrapeVarieties = require('./compareGrapeVarieties');
const recommendWinePairing = require('./recommendWinePairing');
const getWineRouteInformation = require('./getWineRouteInformation');
const updateSessionMemory = require('./updateSessionMemory');
const checkWineMdAvailability = require('./checkWineMdAvailability');
const searchWeb = require('./searchWeb');
const searchPlace = require('./searchPlace');
const fetchPage = require('./fetchPage');

const TOOLS = [
    searchWineKnowledge,
    searchWinery,
    compareGrapeVarieties,
    recommendWinePairing,
    getWineRouteInformation,
    updateSessionMemory,
    checkWineMdAvailability,
    searchWeb,
    searchPlace,
    fetchPage,
];

const TOOL_DECLARATIONS = TOOLS.map((tool) => tool.declaration);

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

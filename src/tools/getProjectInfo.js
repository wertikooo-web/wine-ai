'use strict';

// Authoritative facts about WINE AI itself (identity, creators, history, how
// it works, languages, accuracy, use cases, business, plans, contacts), read
// from knowledge/project/WINE_AI_PROJECT.md. No retrieval, no web: the answer
// to "who made you?" must be the same in every language and never come from
// the internet.

const { getProjectInfo, topicForQuestion, characterNameFrom, TOPICS } = require('../knowledge/projectKnowledge');
const { optionalString } = require('./toolHelpers');

const declaration = {
    name: 'get_project_info',
    description: 'Approved facts about yourself and the WINE AI project: who you are, who created you (Kando Connect, founder, its other projects), history, how you work, languages, where your information comes from, use cases, business collaboration, plans, contacts. Use it for ANY such question in any language instead of searching.',
    parameters: {
        type: 'OBJECT',
        properties: {
            topic: {
                type: 'STRING',
                description: `One of: ${TOPICS.join(', ')}. Use overview for "tell me about yourself".`,
            },
            question: {
                type: 'STRING',
                description: 'The user question as asked (used when topic is unsure).',
            },
        },
        required: [],
    },
};

async function impl(args = {}, toolContext) {
    const topic = optionalString(args.topic, 40);
    const question = optionalString(args.question, 400);
    const chosen = TOPICS.includes(topic) ? topic : (question ? topicForQuestion(question) : 'overview');
    return getProjectInfo(chosen, { characterName: characterNameFrom(toolContext) });
}

module.exports = { declaration, impl };

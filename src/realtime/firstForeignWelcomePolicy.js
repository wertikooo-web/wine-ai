'use strict';

const { buildFirstTurnWelcomeInstruction, shouldSendForeignWelcome } = require('./firstForeignWelcome');

function deriveFirstForeignWelcomeState({
    currentLanguage,
    detectedLanguage,
    alreadySent = false,
    firstMeaningfulTurnSeen = false,
} = {}) {
    if (firstMeaningfulTurnSeen) {
        return {
            firstMeaningfulTurnSeen: true,
            alreadySent,
            welcomePending: false,
            instruction: null,
        };
    }

    const language = String(detectedLanguage || currentLanguage || '').trim().toLowerCase();
    const shouldWelcome = shouldSendForeignWelcome({ language, alreadySent });
    return {
        firstMeaningfulTurnSeen: true,
        alreadySent: alreadySent || shouldWelcome,
        welcomePending: shouldWelcome,
        instruction: shouldWelcome
            ? buildFirstTurnWelcomeInstruction({ language, alreadySent: false })
            : null,
    };
}

module.exports = {
    deriveFirstForeignWelcomeState,
};

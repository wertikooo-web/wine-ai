'use strict';

// Interface every avatar provider must implement — see
// docs/ARCHITECTURE.md's "Avatar" section and Stage 7 of the migration
// plan. Deliberately provider-agnostic: nothing in this file or its
// callers may assume a specific vendor. A real (paid) provider adapter
// goes in src/avatar/providers/<providerName>AvatarProvider.js and must
// implement every method below; src/avatar/providers/mockAvatarProvider.js
// is the default so the whole project runs with zero external services.
//
// audioStream passed to startSpeaking() is provider-defined (could be a
// stream, a base64 PCM chunk, or an event emitter) — this base class does
// not constrain its shape, only that startSpeaking()/stopSpeaking() bracket
// one spoken reply.

class AvatarProvider {
    /** @returns {Promise<void>} */
    async connect() {
        throw new Error('AvatarProvider.connect() not implemented');
    }

    /** @param {*} audioStream @returns {Promise<void>} */
    async startSpeaking(audioStream) { // eslint-disable-line no-unused-vars
        throw new Error('AvatarProvider.startSpeaking() not implemented');
    }

    /** @returns {Promise<void>} */
    async stopSpeaking() {
        throw new Error('AvatarProvider.stopSpeaking() not implemented');
    }

    /** @param {string} language @returns {void} */
    setLanguage(language) { // eslint-disable-line no-unused-vars
        throw new Error('AvatarProvider.setLanguage() not implemented');
    }

    /** @returns {Promise<void>} */
    async disconnect() {
        throw new Error('AvatarProvider.disconnect() not implemented');
    }

    /** @returns {{provider: string, connected: boolean, speaking: boolean, language: string|null}} */
    getStatus() {
        throw new Error('AvatarProvider.getStatus() not implemented');
    }
}

module.exports = { AvatarProvider };

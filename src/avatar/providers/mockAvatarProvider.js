'use strict';

const { AvatarProvider } = require('../AvatarProvider');

// Default avatar provider: a static face with a speaking indicator, no
// external service, no API key. The dashboard client renders the actual
// face/indicator; this class only tracks the state a real (paid) provider
// would otherwise own, so the rest of the project never has to special-case
// "no avatar provider configured".
class MockAvatarProvider extends AvatarProvider {
    constructor() {
        super();
        this.connected = false;
        this.speaking = false;
        this.language = null;
    }

    async connect() {
        this.connected = true;
    }

    async startSpeaking(_audioStream) {
        if (!this.connected) throw new Error('avatar_not_connected');
        this.speaking = true;
    }

    async stopSpeaking() {
        this.speaking = false;
    }

    setLanguage(language) {
        this.language = String(language || '').trim() || null;
    }

    async disconnect() {
        this.connected = false;
        this.speaking = false;
    }

    getStatus() {
        return {
            provider: 'mock',
            connected: this.connected,
            speaking: this.speaking,
            language: this.language,
        };
    }
}

module.exports = { MockAvatarProvider };

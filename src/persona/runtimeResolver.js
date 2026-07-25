'use strict';

/**
 * Pure resolver to determine the active voiceId for a provider session.
 * Maps the 4-level temporary priority hierarchy and returns the resolved voice ID
 * along with its provenance source.
 *
 * @param {Object} params
 * @param {string} params.providerId - Active provider ID (e.g. 'gemini', 'grok')
 * @param {Object} params.profileRuntimeDefaults - Registry defaults for the preset (e.g. { gemini: { voiceId: 'Charon' } })
 * @param {Object} params.runtimeOverrides - Loaded server-side overrides (e.g. { gemini: { voiceId: 'Zephyr' } })
 * @param {string} [params.legacyClientVoiceId] - Client-supplied voice override
 * @param {boolean} params.allowLegacyVoice - Whether legacy client voice overrides are permitted
 * @param {string} params.providerDefaultVoiceId - Default voice fallback for the provider
 * @returns {Object} { providerId, resolvedVoiceId, source: string }
 */
function resolveProfileRuntime({
    providerId,
    profileRuntimeDefaults,
    runtimeOverrides,
    legacyClientVoiceId,
    allowLegacyVoice,
    providerDefaultVoiceId
}) {
    // 1. Explicit server-side runtime override
    if (runtimeOverrides?.[providerId]?.voiceId) {
        return {
            providerId,
            resolvedVoiceId: runtimeOverrides[providerId].voiceId,
            source: 'server_override'
        };
    }

    // 2. Legacy client voiceId, if allowed
    if (allowLegacyVoice && legacyClientVoiceId) {
        return {
            providerId,
            resolvedVoiceId: legacyClientVoiceId,
            source: 'legacy_client'
        };
    }

    // 3. Built-in profile default
    if (profileRuntimeDefaults?.[providerId]?.voiceId) {
        return {
            providerId,
            resolvedVoiceId: profileRuntimeDefaults[providerId].voiceId,
            source: 'profile_default'
        };
    }

    // 4. Provider/server default
    return {
        providerId,
        resolvedVoiceId: providerDefaultVoiceId,
        source: 'provider_default'
    };
}

module.exports = {
    resolveProfileRuntime
};

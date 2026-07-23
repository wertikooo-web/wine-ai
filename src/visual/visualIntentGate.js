'use strict';

const VISUAL_DECISIONS = Object.freeze({
    AVATAR_ONLY: 'avatar_only',
    SHOW_WINE: 'show_wine',
    SHOW_WINE_WITH_COMMERCE: 'show_wine_with_commerce',
    KEEP_CURRENT_WINE: 'keep_current_wine',
    CLEAR_VISUAL: 'clear_visual',
});

const TRUSTED_EVIDENCE_SOURCES = new Set([
    'tool_result',
    'recommendation_engine',
    'screen_context',
    'active_context',
]);

const MIN_CONFIDENCE = 0.75;

function hasPublishedWine(intent) {
    return Boolean(
        intent
        && typeof intent.wineId === 'string'
        && intent.wineId.trim()
        && intent.publicationStatus === 'published'
        && TRUSTED_EVIDENCE_SOURCES.has(intent.evidenceSource)
        && Number(intent.confidence) >= MIN_CONFIDENCE
    );
}

function hasActiveCommerce(intent) {
    const offer = intent && intent.commerce;
    return Boolean(
        offer
        && offer.status === 'active'
        && offer.availability === 'available'
        && Number.isFinite(offer.price)
        && typeof offer.orderUrl === 'string'
        && offer.orderUrl.trim()
    );
}

function decideVisualIntent({ intent = null, activeWineId = null } = {}) {
    if (!intent || intent.type === 'general') {
        return {
            decision: activeWineId ? VISUAL_DECISIONS.CLEAR_VISUAL : VISUAL_DECISIONS.AVATAR_ONLY,
            wineId: null,
            reason: 'no_verified_wine_intent',
        };
    }

    if (
        intent.type === 'follow_up'
        && activeWineId
        && intent.evidenceSource === 'active_context'
        && Number(intent.confidence) >= MIN_CONFIDENCE
    ) {
        if (!intent.wineId || intent.wineId === activeWineId) {
            return {
                decision: VISUAL_DECISIONS.KEEP_CURRENT_WINE,
                wineId: activeWineId,
                reason: 'verified_active_context',
            };
        }
    }

    if (!hasPublishedWine(intent)) {
        return {
            decision: activeWineId ? VISUAL_DECISIONS.CLEAR_VISUAL : VISUAL_DECISIONS.AVATAR_ONLY,
            wineId: null,
            reason: 'wine_not_authoritatively_resolved',
        };
    }

    if (intent.type === 'buy_wine' && hasActiveCommerce(intent)) {
        return {
            decision: VISUAL_DECISIONS.SHOW_WINE_WITH_COMMERCE,
            wineId: intent.wineId,
            reason: 'published_wine_with_active_offer',
        };
    }

    return {
        decision: VISUAL_DECISIONS.SHOW_WINE,
        wineId: intent.wineId,
        reason: 'published_wine_resolved',
    };
}

module.exports = {
    VISUAL_DECISIONS,
    TRUSTED_EVIDENCE_SOURCES,
    MIN_CONFIDENCE,
    decideVisualIntent,
};

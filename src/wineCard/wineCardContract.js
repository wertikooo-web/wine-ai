'use strict';

const WINE_CARD_SCHEMA_VERSION = 1;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validatePublishedWineCard(card) {
    const errors = [];
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
        return { valid: false, errors: ['card must be an object'] };
    }

    if (card.schemaVersion !== WINE_CARD_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${WINE_CARD_SCHEMA_VERSION}`);
    }
    if (!isNonEmptyString(card.wineId)) errors.push('wineId is required');
    if (!isNonEmptyString(card.vintageId)) errors.push('vintageId is required');
    if (card.publicationStatus !== 'published') errors.push('publicationStatus must be published');
    if (!isNonEmptyString(card.locale)) errors.push('locale is required');

    const identity = card.identity;
    if (!identity || typeof identity !== 'object') {
        errors.push('identity is required');
    } else {
        if (!isNonEmptyString(identity.name)) errors.push('identity.name is required');
        if (!isNonEmptyString(identity.wineryId)) errors.push('identity.wineryId is required');
        if (!isNonEmptyString(identity.wineryName)) errors.push('identity.wineryName is required');
        if (!Number.isInteger(identity.vintage)) errors.push('identity.vintage must be an integer');
    }

    const technical = card.technical;
    if (!technical || typeof technical !== 'object') {
        errors.push('technical is required');
    } else {
        if (!Array.isArray(technical.grapes) || technical.grapes.length === 0) {
            errors.push('technical.grapes must contain at least one grape');
        }
        if (!Number.isFinite(technical.alcoholPercentage)) {
            errors.push('technical.alcoholPercentage must be numeric');
        }
        if (!isNonEmptyString(technical.servingTemperature)) {
            errors.push('technical.servingTemperature is required');
        }
    }

    const presentation = card.presentation;
    if (!presentation || typeof presentation !== 'object') {
        errors.push('presentation is required');
    } else {
        if (!isNonEmptyString(presentation.shortDescription)) {
            errors.push('presentation.shortDescription is required');
        }
        if (!Array.isArray(presentation.aromas)) errors.push('presentation.aromas must be an array');
        if (!Array.isArray(presentation.pairings)) errors.push('presentation.pairings must be an array');
    }

    const bottle = card.media && card.media.bottle;
    if (!bottle || !isNonEmptyString(bottle.url)) {
        errors.push('media.bottle.url is required');
    } else if (bottle.rightsStatus !== 'approved') {
        errors.push('media.bottle.rightsStatus must be approved');
    }

    const provenance = card.provenance;
    if (!provenance || provenance.verified !== true) {
        errors.push('provenance.verified must be true');
    } else if (!Array.isArray(provenance.sourceIds) || provenance.sourceIds.length === 0) {
        errors.push('provenance.sourceIds must contain at least one source');
    }

    if (card.commerce != null) {
        const offer = card.commerce;
        if (offer.status !== 'active') errors.push('commerce.status must be active');
        if (!Number.isFinite(offer.price) || offer.price < 0) errors.push('commerce.price must be non-negative');
        if (!isNonEmptyString(offer.currency)) errors.push('commerce.currency is required');
        if (!isNonEmptyString(offer.orderUrl)) errors.push('commerce.orderUrl is required');
    }

    return { valid: errors.length === 0, errors };
}

module.exports = { WINE_CARD_SCHEMA_VERSION, validatePublishedWineCard };

'use strict';

/**
 * WINE AI KOS - Winery Label Dictionary (Step 3B Production)
 *
 * Case-insensitive, Unicode NFC normalized label dictionaries for winery fields across Romanian, Russian, and English.
 */

const WINERY_LABEL_DICTIONARY_VERSION = '1.0.0';

const WINERY_LABELS = Object.freeze({
    'winery.brandName': Object.freeze({
        fieldPath: 'winery.brandName',
        labels: Object.freeze({
            ro: Object.freeze(['crama', 'vinăria', 'producător', 'brand']),
            ru: Object.freeze(['винодельня', 'производитель', 'бренд', 'винарня']),
            en: Object.freeze(['winery', 'producer', 'brand name', 'estate']),
        }),
    }),
    'winery.foundingYear': Object.freeze({
        fieldPath: 'winery.foundingYear',
        labels: Object.freeze({
            ro: Object.freeze(['anul fondării', 'fondat în', 'fondat']),
            ru: Object.freeze(['год основания', 'основан в', 'основана в', 'основан']),
            en: Object.freeze(['founded in', 'established in', 'founded', 'est.']),
        }),
    }),
    'winery.website': Object.freeze({
        fieldPath: 'winery.website',
        labels: Object.freeze({
            ro: Object.freeze(['site oficial', 'website', 'site']),
            ru: Object.freeze(['официальный сайт', 'веб-сайт', 'сайт']),
            en: Object.freeze(['official website', 'website', 'web']),
        }),
    }),
    'winery.email': Object.freeze({
        fieldPath: 'winery.email',
        labels: Object.freeze({
            ro: Object.freeze(['email', 'e-mail', 'posta electronica']),
            ru: Object.freeze(['электронная почта', 'e-mail', 'email', 'почта']),
            en: Object.freeze(['email', 'e-mail', 'contact email']),
        }),
    }),
    'winery.phone': Object.freeze({
        fieldPath: 'winery.phone',
        labels: Object.freeze({
            ro: Object.freeze(['telefon', 'tel.']),
            ru: Object.freeze(['телефон', 'тел.']),
            en: Object.freeze(['phone', 'tel.']),
        }),
    }),
});

module.exports = {
    WINERY_LABEL_DICTIONARY_VERSION,
    WINERY_LABELS,
};

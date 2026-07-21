'use strict';

/**
 * WINE AI KOS - Wine Label Dictionary (Step 3B Production)
 *
 * Case-insensitive, Unicode NFC normalized label dictionaries for wine fields across Romanian, Russian, and English.
 */

const WINE_LABEL_DICTIONARY_VERSION = '1.0.0';

const WINE_LABELS = Object.freeze({
    'wine.alcoholPercent': Object.freeze({
        fieldPath: 'wine.alcoholPercent',
        labels: Object.freeze({
            ro: Object.freeze(['alcool', 'tărie alcoolică', 'tărie', 'volum alcoolic', 'alc.']),
            ru: Object.freeze(['алкоголь', 'крепость', 'содержание алкоголя', 'спирт', 'алк.']),
            en: Object.freeze(['alcohol', 'alcohol by volume', 'abv', 'alc.']),
        }),
    }),
    'wine.vintageYear': Object.freeze({
        fieldPath: 'wine.vintageYear',
        labels: Object.freeze({
            ro: Object.freeze(['anul recoltei', 'an recolta', 'anul', 'vintage']),
            ru: Object.freeze(['год урожая', 'винтаж', 'год']),
            en: Object.freeze(['vintage year', 'vintage', 'harvest year']),
        }),
    }),
    'wine.volumeMl': Object.freeze({
        fieldPath: 'wine.volumeMl',
        labels: Object.freeze({
            ro: Object.freeze(['volum', 'capacitate', 'vol.']),
            ru: Object.freeze(['объем', 'емкость', 'об’єм']),
            en: Object.freeze(['volume', 'bottle size', 'capacity', 'net volume']),
        }),
    }),
    'wine.price': Object.freeze({
        fieldPath: 'wine.price',
        labels: Object.freeze({
            ro: Object.freeze(['preț', 'pret', 'tarif']),
            ru: Object.freeze(['цена', 'стоимость']),
            en: Object.freeze(['price', 'cost']),
        }),
    }),
});

module.exports = {
    WINE_LABEL_DICTIONARY_VERSION,
    WINE_LABELS,
};

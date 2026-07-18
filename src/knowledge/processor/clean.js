'use strict';

const crypto = require('crypto');

const MAX_TEXT_CHARS = 20000;
const MIN_TEXT_CHARS = 100;

function cleanText(rawText) {
    return String(rawText || '')
        .replace(/ /g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_TEXT_CHARS);
}

function contentHash(text) {
    return crypto.createHash('sha256').update(cleanText(text), 'utf8').digest('hex');
}

function isSubstantial(text) {
    return cleanText(text).length >= MIN_TEXT_CHARS;
}

module.exports = { cleanText, contentHash, isSubstantial, MIN_TEXT_CHARS, MAX_TEXT_CHARS };

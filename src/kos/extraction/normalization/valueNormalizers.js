'use strict';

/**
 * WINE AI KOS - Deterministic Value Normalizers (Step 3A Refined)
 *
 * Strict normalizers separated from extraction/parsing. Does not attempt to guess ambiguous text.
 */

function normalizeString(val) {
    if (val === undefined || val === null) return null;
    const str = String(val).normalize('NFC').trim();
    return str.replace(/\s+/g, ' ');
}

function normalizeDecimal(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;

    const str = String(val).trim();
    // Reject ambiguous mixed locale thousand separators (e.g. 1.234,50 or 1,234.50)
    if ((str.includes('.') && str.includes(',')) || (str.match(/,/g) || []).length > 1 || (str.match(/\./g) || []).length > 1) {
        return null; // Ambiguous format rejected by normalizer
    }

    const cleanStr = str.replace(',', '.');
    if (!/^[+-]?\d+(\.\d+)?$/.test(cleanStr)) {
        return null;
    }

    const num = parseFloat(cleanStr);
    return Number.isFinite(num) ? num : null;
}

function normalizeInteger(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number' && Number.isInteger(val)) return val;
    const str = String(val).trim();
    if (!/^[+-]?\d+$/.test(str)) return null;
    const num = parseInt(str, 10);
    return Number.isInteger(num) ? num : null;
}

function normalizeBoolean(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'boolean') return val;
    const str = String(val).trim().toLowerCase();
    if (['true', 'yes', 'da', '1'].includes(str)) return true;
    if (['false', 'no', 'nu', '0'].includes(str)) return false;
    return null;
}

function normalizePercentage(val) {
    if (val === undefined || val === null) return null;
    let str = String(val).trim().replace(/%|vol\.?/gi, '').trim();
    return normalizeDecimal(str);
}

function normalizeYear(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number' && Number.isInteger(val) && val >= 1000 && val <= 9999) {
        return val;
    }
    const str = String(val).trim();
    // Must be exact 4-digit year string without surrounding text sentence guessing
    if (!/^(1[5-9]\d{2}|20\d{2})$/.test(str)) {
        return null;
    }
    return parseInt(str, 10);
}

function normalizeVolume(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) return val;

    const str = String(val).toLowerCase().replace(',', '.').trim();

    if (str.endsWith('l') && !str.endsWith('ml')) {
        const numStr = str.replace(/l$/, '').trim();
        const liters = normalizeDecimal(numStr);
        return liters !== null ? Math.round(liters * 1000) : null;
    }

    const numStr = str.replace(/ml$/, '').trim();
    return normalizeInteger(numStr);
}

function normalizeMoney(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'object' && typeof val.amount === 'number' && typeof val.currency === 'string') {
        return { amount: val.amount, currency: val.currency.toUpperCase() };
    }

    const str = String(val).trim();
    let currency = 'MDL';
    if (str.includes('€') || /EUR/i.test(str)) currency = 'EUR';
    else if (str.includes('$') || /USD/i.test(str)) currency = 'USD';
    else if (/RON/i.test(str)) currency = 'RON';

    const numStr = str.replace(/€|\$|EUR|USD|MDL|RON/gi, '').trim();
    const amount = normalizeDecimal(numStr);
    if (amount === null) return null;

    return { amount, currency };
}

function normalizeUrl(val) {
    if (!val) return null;
    let str = String(val).trim();
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str)) {
        if (!str.toLowerCase().startsWith('http://') && !str.toLowerCase().startsWith('https://')) {
            return null; // Reject non-http/https schemes like ftp:// or mailto:
        }
    } else {
        str = 'https://' + str;
    }
    try {
        const u = new URL(str);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function normalizeEmail(val) {
    if (!val) return null;
    const str = String(val).trim();
    const parts = str.split('@');
    if (parts.length !== 2) return null;
    const local = parts[0].trim();
    const domain = parts[1].trim().toLowerCase();
    if (!local || !domain || !domain.includes('.')) return null;
    return `${local}@${domain}`;
}

function normalizePhone(val) {
    if (!val) return null;
    const str = String(val).trim();
    const hasPlus = str.startsWith('+');
    const digits = str.replace(/\D/g, '');
    if (!digits || digits.length < 5) return null;
    return hasPlus ? `+${digits}` : digits;
}

function normalizeLanguageTag(val) {
    if (!val) return null;
    const str = String(val).trim().toLowerCase().slice(0, 2);
    if (['ru', 'ro', 'en'].includes(str)) return str;
    return null;
}

module.exports = {
    normalizeString,
    normalizeDecimal,
    normalizeInteger,
    normalizeBoolean,
    normalizePercentage,
    normalizeYear,
    normalizeVolume,
    normalizeMoney,
    normalizeUrl,
    normalizeEmail,
    normalizePhone,
    normalizeLanguageTag,
};

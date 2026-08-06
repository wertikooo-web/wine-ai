'use strict';

const t = require('./helpers/assertions');
const { COOKIE_NAME, MAX_AGE_MS, issueAdultCookie, isAdultVerified, parseCookies } = require('../src/security/ageVerification');

async function run() {
    const now = 1_700_000_000_000;
    const setCookie = issueAdultCookie({ now });
    const cookiePair = setCookie.split(';')[0];
    t.equal(parseCookies(cookiePair)[COOKIE_NAME] !== undefined, true, 'the verification cookie must be parseable');
    t.equal(isAdultVerified(cookiePair, { now: now + 1 }), true, 'a freshly issued signed cookie must be accepted');
    t.equal(isAdultVerified(cookiePair, { now: now + MAX_AGE_MS + 1 }), false, 'an expired cookie must be rejected');
    t.equal(isAdultVerified(`${COOKIE_NAME}=forged.payload`, { now: now + 1 }), false, 'a forged cookie must be rejected');
    t.equal(isAdultVerified(`${COOKIE_NAME}=%ZZ`, { now }), false, 'a malformed cookie must be rejected safely');
    t.equal(isAdultVerified('', { now }), false, 'missing cookie must be rejected');
}

module.exports = { run };

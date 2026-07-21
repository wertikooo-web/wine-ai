'use strict';

/**
 * WINE AI KOS - SSRF Protection Test Suite (Step 2C.1)
 */

const assert = require('assert');
const { validateUrlSsrf, isPrivateIp, SsrfValidationError } = require('../src/kos/sources/ssrfProtection');

async function run() {
    let assertions = 0;
    const assertEqual = (a, b) => { assertions++; assert.strictEqual(a, b); };
    const assertOk = (cond) => { assertions++; assert.ok(cond); };

    // 1. IP Private Range Detection
    assertOk(isPrivateIp('127.0.0.1'));
    assertOk(isPrivateIp('10.0.0.1'));
    assertOk(isPrivateIp('172.16.0.1'));
    assertOk(isPrivateIp('192.168.1.1'));
    assertOk(isPrivateIp('169.254.169.254')); // Cloud metadata IP
    assertOk(isPrivateIp('::1'));
    assertEqual(isPrivateIp('93.184.216.34'), false); // Public IP

    // 2. Reject URLs with Embedded Credentials
    await assert.rejects(
        async () => validateUrlSsrf('http://user:pass@example.com'),
        (err) => {
            assertEqual(err.code, 'KOS_SSRF_CREDENTIALS_REJECTED');
            return true;
        }
    );

    // 3. Reject Disallowed Protocol (ftp, file)
    await assert.rejects(
        async () => validateUrlSsrf('file:///etc/passwd'),
        (err) => {
            assertEqual(err.code, 'KOS_SSRF_DISALLOWED_PROTOCOL');
            return true;
        }
    );

    // 4. Reject Disallowed Ports (e.g. 22, 8080)
    await assert.rejects(
        async () => validateUrlSsrf('http://example.com:8080'),
        (err) => {
            assertEqual(err.code, 'KOS_SSRF_DISALLOWED_PORT');
            return true;
        }
    );

    // 5. Reject Blocked Internal Domains
    await assert.rejects(
        async () => validateUrlSsrf('http://app.railway.internal'),
        (err) => {
            assertEqual(err.code, 'KOS_SSRF_BLOCKED_HOST');
            return true;
        }
    );

    // 6. Reject Alternative IP Notation (Decimal / Hex)
    await assert.rejects(
        async () => validateUrlSsrf('http://2130706433'),
        (err) => {
            assertEqual(err.code, 'KOS_SSRF_ALTERNATIVE_IP_REJECTED');
            return true;
        }
    );

    // 7. Accept Valid Public Domain (aurelius.md or example.com)
    const validResult = await validateUrlSsrf('https://wineofmoldova.com/en/about-onvv/');
    assertOk(validResult.canonicalUrl.startsWith('https://wineofmoldova.com'));
    assertEqual(validResult.normalizedOrigin, 'https://wineofmoldova.com');
    assertOk(validResult.verifiedIps.length > 0);

    console.log(`kosSsrfProtection.test.js: All ${assertions} assertions passed successfully!`);
    return { assertionCount: assertions };
}

module.exports = { run };

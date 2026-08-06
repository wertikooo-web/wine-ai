'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
    computeMigrationChecksum,
    computeMigrationChecksumVariants,
    isMigrationChecksumCompatible,
} = require('../src/kos/db/kosSchema');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function run() {
    const migration = {
        up: async (client) => {
            await client.query(`
                CREATE TABLE example (
                    id TEXT PRIMARY KEY
                );
            `);
        },
    };

    const lfSource = migration.up.toString().replace(/\r\n?/g, '\n');
    const lfChecksum = sha256(lfSource);
    const crlfChecksum = sha256(lfSource.replace(/\n/g, '\r\n'));
    const variants = computeMigrationChecksumVariants(migration);

    assert.strictEqual(computeMigrationChecksum(migration), lfChecksum);
    assert.strictEqual(variants.has(lfChecksum), true);
    assert.strictEqual(variants.has(crlfChecksum), true);
    assert.strictEqual(isMigrationChecksumCompatible(migration, lfChecksum), true);
    assert.strictEqual(isMigrationChecksumCompatible(migration, crlfChecksum), true);
    assert.strictEqual(isMigrationChecksumCompatible(migration, 'dev'), true);
    assert.strictEqual(isMigrationChecksumCompatible(migration, 'not-a-real-checksum'), false);

    const changedMigration = {
        up: async (client) => {
            await client.query('CREATE TABLE materially_changed (id TEXT PRIMARY KEY);');
        },
    };
    assert.strictEqual(
        isMigrationChecksumCompatible(changedMigration, lfChecksum),
        false,
        'real migration source changes must still be rejected'
    );

    console.log('kosMigrationChecksum.test.js: portable checksum compatibility tests passed.');
}

module.exports = { run };

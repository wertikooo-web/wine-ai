'use strict';

const assert = require('assert');

function deepClone(entries) {
    return JSON.parse(JSON.stringify(entries));
}

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

class RegistryDouble {
    constructor() {
        this.tables = new Map();
        this.rowLocks = new Map();
        this._lockWaiters = [];
        this.holdLocksOnNext = false;
        this._holdRelease = null;
        this.failAtStmt = 0;
        this._stmtCount = 0;
        this._clientSeq = 0;
    }

    reset() {
        this.tables.clear();
        this.rowLocks.clear();
        this._lockWaiters = [];
        this.holdLocksOnNext = false;
        this._holdRelease = null;
        this.failAtStmt = 0;
        this._stmtCount = 0;
    }

    clearFail() {
        this.failAtStmt = 0;
        this._stmtCount = 0;
    }

    releaseHold() {
        if (this._holdRelease) {
            this._holdRelease();
            this._holdRelease = null;
        }
    }

    _ensure(name) {
        if (!this.tables.has(name)) {
            this.tables.set(name, { name, rows: [] });
        }
        return this.tables.get(name);
    }

    table(name) {
        const t = this.tables.get(name);
        return t ? t.rows : [];
    }

    seedBuild({ build_id, status, input_fingerprint = 'fp', input_snapshot = '{}', source_count = 0 }) {
        const t = this._ensure('build_registry_builds');
        t.rows = t.rows.filter((r) => r.build_id !== build_id);
        t.rows.push({ build_id, status, input_fingerprint, input_snapshot, source_count });
        return build_id;
    }

    setState(key, value) {
        const t = this._ensure('build_registry_state');
        const idx = t.rows.findIndex((r) => r.key === key);
        if (idx >= 0) {
            t.rows[idx].value = value;
        } else {
            t.rows.push({ key, value });
        }
    }

    connect() {
        const engine = this;
        const client = { id: ++this._clientSeq, inTxn: false, stack: [] };
        client.query = async (sql, params = []) => {
            const norm = String(sql).trim().replace(/\s+/g, ' ');
            if (/^BEGIN$/i.test(norm)) {
                client.inTxn = true;
                client.stack.push(deepClone([...engine.tables.entries()]));
                return { rows: [] };
            }
            if (/^COMMIT$/i.test(norm)) {
                client.inTxn = false;
                client.stack.pop();
                engine._releaseClientLocks(client);
                return { rows: [] };
            }
            if (/^ROLLBACK$/i.test(norm)) {
                if (client.inTxn && client.stack.length) {
                    const snapshot = client.stack.pop();
                    engine.tables = new Map(snapshot);
                }
                client.inTxn = false;
                engine._releaseClientLocks(client);
                return { rows: [] };
            }
            return engine._exec(client, sql, params);
        };
        client.release = () => {};
        return client;
    }

    async query(sql, params = []) {
        return this._exec(null, sql, params);
    }

    async _exec(client, rawSql, params = []) {
        const sql = String(rawSql).trim().replace(/\s+/g, ' ');

        if (/^CREATE EXTENSION/i.test(sql)) return { rows: [] };
        if (/^CREATE (UNIQUE )?INDEX/i.test(sql)) return { rows: [] };
        if (/^ALTER TABLE/i.test(sql)) return { rows: [] };
        if (/^DROP TABLE/i.test(sql)) {
            const m = sql.match(/DROP TABLE IF EXISTS (\w+)/i);
            if (m) this.tables.delete(m[1]);
            return { rows: [] };
        }
        if (/^CREATE TABLE/i.test(sql)) {
            const m = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
            if (m) this._ensure(m[1]);
            return { rows: [] };
        }

        this._stmtCount += 1;
        if (this.failAtStmt && this._stmtCount === this.failAtStmt) {
            const injected = new Error('injected failure');
            injected.code = 'INJECTED';
            throw injected;
        }

        if (/^INSERT INTO build_registry_state/.test(sql)) {
            const t = this._ensure('build_registry_state');
            const key = params[0];
            const value = params[1];
            const idx = t.rows.findIndex((r) => r.key === key);
            if (idx >= 0 && /ON CONFLICT.*DO NOTHING/i.test(sql)) return { rows: [] };
            if (idx >= 0) {
                t.rows[idx].value = value;
            } else {
                t.rows.push({ key, value });
            }
            return { rows: [] };
        }
        if (/^INSERT INTO build_registry_chunks/.test(sql)) {
            const buildId = params[0];
            if (!this.table('build_registry_builds').some((r) => r.build_id === buildId)) {
                const err = new Error('FK violation: build_id not found');
                err.code = '23503';
                throw err;
            }
            this._ensure('build_registry_chunks').rows.push({ build_id: params[0], chunk_id: params[1] });
            return { rows: [] };
        }

        let m = sql.match(/^SELECT value FROM build_registry_state WHERE key IN \(\$1,\s*\$2\) FOR UPDATE$/i);
        if (m) {
            const keys = [params[0], params[1]];
            for (const key of keys) {
                await this._acquire(client, key);
            }
            const t = this._ensure('build_registry_state');
            return { rows: t.rows.filter((r) => keys.includes(r.key)) };
        }
        m = sql.match(/^SELECT value FROM build_registry_state WHERE key = \$1\s*(FOR UPDATE)?$/i);
        if (m) {
            const key = params[0];
            if (/FOR UPDATE$/i.test(m[0])) {
                await this._acquire(client, key);
            }
            const t = this._ensure('build_registry_state');
            return { rows: t.rows.filter((r) => r.key === key) };
        }
        m = sql.match(/^SELECT status FROM build_registry_builds WHERE build_id = \$1\s*(FOR UPDATE)?$/i);
        if (m) {
            const t = this._ensure('build_registry_builds');
            return { rows: t.rows.filter((r) => r.build_id === params[0]).map((r) => ({ status: r.status })) };
        }
        if (/^UPDATE build_registry_builds SET status = \$1/i.test(sql)) {
            const t = this._ensure('build_registry_builds');
            const row = t.rows.find((r) => r.build_id === params[1]);
            if (row) row.status = params[0];
            return { rows: [] };
        }
        if (/^UPDATE build_registry_state SET value = \$1/i.test(sql)) {
            const t = this._ensure('build_registry_state');
            const idx = t.rows.findIndex((r) => r.key === params[1]);
            if (idx >= 0) {
                t.rows[idx].value = params[0];
            } else {
                t.rows.push({ key: params[1], value: params[0] });
            }
            return { rows: [] };
        }
        if (/^DELETE FROM build_registry_state WHERE key = \$1/i.test(sql)) {
            const t = this._ensure('build_registry_state');
            t.rows = t.rows.filter((r) => r.key !== params[0]);
            return { rows: [] };
        }

        throw new Error('unsupported SQL: ' + sql);
    }

    async _acquire(client, key) {
        const holder = this.rowLocks.get(key);
        if (holder === client) return;
        if (holder) {
            await new Promise((resolve) => {
                this._lockWaiters.push({ key, resolve, client });
            });
            if (this.rowLocks.get(key) && this.rowLocks.get(key) !== client) {
                return this._acquire(client, key);
            }
        }
        if (this.holdLocksOnNext) {
            this.holdLocksOnNext = false;
            this.rowLocks.set(key, client);
            await new Promise((resolve) => {
                this._holdRelease = resolve;
            });
            return;
        }
        this.rowLocks.set(key, client);
    }

    _releaseClientLocks(client) {
        const free = [];
        for (const [key, holder] of this.rowLocks) {
            if (holder === client) {
                this.rowLocks.delete(key);
                free.push(key);
            }
        }
        if (!free.length) return;
        const waiters = this._lockWaiters;
        this._lockWaiters = [];
        for (const w of waiters) {
            if (free.includes(w.key) || !this.rowLocks.has(w.key)) {
                this.rowLocks.set(w.key, w.client);
                w.resolve();
            } else {
                this._lockWaiters.push(w);
            }
        }
    }
}

function stateOf(d, key) {
    const r = d.table('build_registry_state').find((x) => x.key === key);
    return r ? r.value : undefined;
}

function statusOf(d, buildId) {
    const r = d.table('build_registry_builds').find((x) => x.build_id === buildId);
    return r ? r.status : undefined;
}

function buildsWithStatus(d, status) {
    return d.table('build_registry_builds').filter((x) => x.status === status);
}

async function run() {
    const registry = require('../src/buildRegistry/registry');
    const legacy = registry.LEGACY_BUILD;
    let n = 0;
    const ok = (cond) => {
        n += 1;
        assert.ok(cond);
    };

    const double = new RegistryDouble();
    await registry.initSchema(double);
    await registry.initSchema(double);

    ok(stateOf(double, 'active_build') === legacy);
    ok(stateOf(double, 'previous_build') === legacy);
    const initial = await registry.resolveActiveBuild(double);
    ok(initial.build_id === legacy);

    await double.query('DELETE FROM build_registry_state WHERE key = $1', [registry.ACTIVE_KEY]);
    const missing = await registry.resolveActiveBuild(double);
    ok(missing.error === registry.ERROR.MISSING_ACTIVE_BUILD);
    await registry.initSchema(double);
    ok(stateOf(double, 'active_build') === legacy);

    double.setState('active_build', 'does-not-exist');
    const dangling = await registry.resolveActiveBuild(double);
    ok(dangling.error === registry.ERROR.INVALID_ACTIVE_BUILD);
    ok(dangling.build_id === 'does-not-exist');
    double.setState('active_build', legacy);

    await assert.rejects(
        () => registry.activateBuild(double, legacy),
        (e) => e.code === registry.ERROR.INVALID_TARGET
    );
    await assert.rejects(
        () => registry.activateBuild(double, 'missing-build'),
        (e) => e.code === registry.ERROR.BUILD_NOT_FOUND
    );
    double.seedBuild({ build_id: 'b1', status: 'building' });
    await assert.rejects(
        () => registry.activateBuild(double, 'b1'),
        (e) => e.code === registry.ERROR.BUILD_NOT_READY
    );
    double.seedBuild({ build_id: 'b1', status: 'ready' });

    const r1 = await registry.activateBuild(double, 'b1');
    ok(r1.build_id === 'b1');
    ok(r1.previous_build === legacy);
    ok(stateOf(double, 'active_build') === 'b1');
    ok(stateOf(double, 'previous_build') === legacy);
    ok(statusOf(double, 'b1') === 'active');
    ok(buildsWithStatus(double, 'active').length === 1);

    double.seedBuild({ build_id: 'b2', status: 'ready' });
    const r2 = await registry.activateBuild(double, 'b2');
    ok(r2.build_id === 'b2');
    ok(r2.previous_build === 'b1');
    ok(statusOf(double, 'b1') === 'ready');
    ok(statusOf(double, 'b2') === 'active');
    ok(stateOf(double, 'active_build') === 'b2');
    ok(stateOf(double, 'previous_build') === 'b1');
    ok(buildsWithStatus(double, 'active').length === 1);

    const rr = await registry.rollbackBuild(double);
    ok(rr.build_id === 'b1');
    ok(rr.rolled_back === 'b2');
    ok(stateOf(double, 'active_build') === 'b1');
    ok(stateOf(double, 'previous_build') === legacy);
    ok(statusOf(double, 'b2') === 'rolled_back');
    ok(statusOf(double, 'b1') === 'active');
    ok(buildsWithStatus(double, 'active').length === 1);

    const rr2 = await registry.rollbackBuild(double);
    ok(rr2.build_id === legacy);
    ok(rr2.rolled_back === 'b1');
    ok(stateOf(double, 'active_build') === legacy);
    ok(statusOf(double, 'b1') === 'rolled_back');

    double.seedBuild({ build_id: 'b3', status: 'ready' });
    double.setState('active_build', 'b1');
    double.setState('previous_build', legacy);
    await registry.activateBuild(double, 'b3');

    double.setState('previous_build', 'ghost');
    await assert.rejects(
        () => registry.rollbackBuild(double),
        (e) => e.code === registry.ERROR.INVALID_PREVIOUS_BUILD
    );
    ok(stateOf(double, 'active_build') === 'b3');
    ok(statusOf(double, 'b3') === 'active');
    ok(stateOf(double, 'previous_build') === 'ghost');

    double.setState('previous_build', 'b3');
    await assert.rejects(
        () => registry.rollbackBuild(double),
        (e) => e.code === registry.ERROR.INVALID_PREVIOUS_BUILD
    );
    ok(stateOf(double, 'active_build') === 'b3');
    ok(statusOf(double, 'b3') === 'active');
    ok(stateOf(double, 'previous_build') === 'b3');

    double.setState('previous_build', 'b1');
    const rr3 = await registry.rollbackBuild(double);
    ok(rr3.build_id === 'b1');
    ok(rr3.rolled_back === 'b3');
    ok(stateOf(double, 'active_build') === 'b1');
    ok(stateOf(double, 'previous_build') === legacy);

    await assert.rejects(
        () => double.query(
            'INSERT INTO build_registry_chunks (build_id, chunk_id, source_file, text, content_hash, version_key) VALUES ($1, $2, $3, $4, $5, $6)',
            ['ghost-build', 'c1', 'source', 'text', 'hash', 'v1']
        ),
        (e) => {
            ok(e.code === '23503');
            return true;
        }
    );

    double.reset();
    await registry.initSchema(double);
    double.seedBuild({ build_id: 'b1', status: 'ready' });
    await registry.activateBuild(double, 'b1');
    double.seedBuild({ build_id: 'b2', status: 'ready' });
    await registry.activateBuild(double, 'b2');
    double.seedBuild({ build_id: 'b3', status: 'ready' });
    double.clearFail();
    double.failAtStmt = 8;
    await assert.rejects(
        () => registry.activateBuild(double, 'b3'),
        (e) => {
            ok(e.code === 'INJECTED');
            return true;
        }
    );
    ok(stateOf(double, 'active_build') === 'b2');
    ok(stateOf(double, 'previous_build') === 'b1');
    ok(statusOf(double, 'b1') === 'ready');
    ok(statusOf(double, 'b2') === 'active');
    ok(statusOf(double, 'b3') === 'ready');
    ok(buildsWithStatus(double, 'active').length === 1);

    double.clearFail();
    double.reset();
    await registry.initSchema(double);
    double.seedBuild({ build_id: 'b1', status: 'ready' });
    double.seedBuild({ build_id: 'b2', status: 'ready' });
    double.holdLocksOnNext = true;
    const pA = registry.activateBuild(double, 'b1');
    await tick();
    const pB = registry.activateBuild(double, 'b2');
    await tick();
    double.releaseHold();
    const [ra, rb] = await Promise.all([pA, pB]);
    ok(ra.build_id === 'b1');
    ok(rb.build_id === 'b2');
    ok(stateOf(double, 'active_build') === 'b2');
    ok(stateOf(double, 'previous_build') === 'b1');
    ok(statusOf(double, 'b1') === 'ready');
    ok(statusOf(double, 'b2') === 'active');
    ok(buildsWithStatus(double, 'active').length === 1);

    return { assertionCount: n };
}

if (require.main === module) {
    run()
        .then((r) => {
            console.log(`buildRegistryFoundation: ${r.assertionCount} assertions OK`);
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

module.exports = { run };
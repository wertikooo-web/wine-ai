'use strict';

// In-memory fact cache with TTL — sits between intent routing and fact
// retrieval to avoid repeated disk reads or external fetches for hot facts.
//
// Design:
// - Key = `${entity_id}:${fact_type}`
// - Value = { fact, fetchedAt, expiresAt }
// - Memory-only, no persistence (session-scoped or global with bounded size)
// - LRU eviction when max size reached

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_GLOBAL_TTL_MS = 5 * 60 * 1000; // 5 minutes for cache entries

class FactCache {
    constructor({ maxEntries = DEFAULT_MAX_ENTRIES, globalTtlMs = DEFAULT_GLOBAL_TTL_MS } = {}) {
        this._cache = new Map();
        this._maxEntries = maxEntries;
        this._globalTtlMs = globalTtlMs;
        this._hits = 0;
        this._misses = 0;
    }

    _key(entityId, factType) {
        return `${entityId}:${factType}`;
    }

    get(entityId, factType) {
        const key = this._key(entityId, factType);
        const entry = this._cache.get(key);
        if (!entry) {
            this._misses++;
            return null;
        }
        if (Date.now() > entry.expiresAt) {
            this._cache.delete(key);
            this._misses++;
            return null;
        }
        this._hits++;
        return entry.fact;
    }

    set(entityId, factType, fact, ttlMs) {
        const key = this._key(entityId, factType);
        const effectiveTtl = ttlMs || this._globalTtlMs;

        // LRU eviction: delete oldest entry when full
        if (this._cache.size >= this._maxEntries && !this._cache.has(key)) {
            const firstKey = this._cache.keys().next().value;
            this._cache.delete(firstKey);
        }

        this._cache.set(key, {
            fact,
            fetchedAt: Date.now(),
            expiresAt: Date.now() + effectiveTtl,
        });
    }

    invalidate(entityId, factType) {
        const key = this._key(entityId, factType);
        this._cache.delete(key);
    }

    invalidateEntity(entityId) {
        const prefix = `${entityId}:`;
        for (const key of this._cache.keys()) {
            if (key.startsWith(prefix)) this._cache.delete(key);
        }
    }

    clear() {
        this._cache.clear();
        this._hits = 0;
        this._misses = 0;
    }

    stats() {
        return {
            size: this._cache.size,
            maxEntries: this._maxEntries,
            hits: this._hits,
            misses: this._misses,
            hitRate: this._hits + this._misses > 0
                ? Math.round((this._hits / (this._hits + this._misses)) * 100)
                : 0,
        };
    }
}

// Global singleton for cross-session cache
const globalCache = new FactCache();

module.exports = { FactCache, globalCache };

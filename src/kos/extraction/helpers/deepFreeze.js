'use strict';

/**
 * WINE AI KOS - Recursive Deep Freeze Helper (Step 3A Production)
 *
 * Enforces true deep immutability for contracts, preventing modification of nested objects or arrays.
 */

function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Object.isFrozen(obj)) {
        return obj;
    }

    const propNames = Reflect.ownKeys(obj);
    for (const name of propNames) {
        const value = obj[name];
        if (value && typeof value === 'object') {
            deepFreeze(value);
        }
    }

    return Object.freeze(obj);
}

module.exports = {
    deepFreeze,
};

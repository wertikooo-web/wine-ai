'use strict';

/**
 * Backward compatibility re-export of core text parser.
 */

const textParser = require('./core/textParser');
const parserContracts = require('./core/parserContracts');

module.exports = {
    ...textParser,
    ...parserContracts,
};

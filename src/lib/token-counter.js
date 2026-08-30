'use strict';

const { get_encoding: getEncoding } = require('tiktoken');
const { config } = require('./corpus-pipeline');

const configuredEncodings = config.upload.tokenEncodings || ['o200k_base', 'cl100k_base'];
const encodings = new Map();

function encoding(name) {
    if (!encodings.has(name)) encodings.set(name, getEncoding(name));
    return encodings.get(name);
}

/**
 * Count with every configured OpenAI encoding and use the largest result for
 * capacity decisions. This is deliberately conservative across model changes.
 */
function countTokens(text) {
    const value = String(text || '');
    const byEncoding = Object.fromEntries(configuredEncodings.map(name => [
        name,
        encoding(name).encode(value).length
    ]));
    return {
        tokens: Math.max(0, ...Object.values(byEncoding)),
        byEncoding
    };
}

function tokenCount(text) {
    return countTokens(text).tokens;
}

/** Find a safe character boundary whose encoded prefix stays within a token budget. */
function prefixWithinTokenLimit(text, maximumTokens) {
    const value = String(text || '');
    if (tokenCount(value) <= maximumTokens) return value.length;
    let low = 0;
    let high = value.length;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (tokenCount(value.slice(0, middle)) <= maximumTokens) low = middle;
        else high = middle;
    }
    return low;
}

module.exports = {
    configuredEncodings,
    countTokens,
    prefixWithinTokenLimit,
    tokenCount
};

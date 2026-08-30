'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { countTokens, prefixWithinTokenLimit, tokenCount } = require('../src/lib/token-counter');

test('counts real tokens with both configured OpenAI encodings', () => {
    const result = countTokens('hello world');
    assert.equal(result.byEncoding.o200k_base, 2);
    assert.equal(result.byEncoding.cl100k_base, 2);
    assert.equal(result.tokens, 2);
});

test('finds a prefix by encoded token count rather than character division', () => {
    const text = 'vědomí '.repeat(200);
    const end = prefixWithinTokenLimit(text, 40);
    assert.ok(end > 0 && end < text.length);
    assert.ok(tokenCount(text.slice(0, end)) <= 40);
    assert.ok(tokenCount(text.slice(0, Math.min(text.length, end + 20))) > 40);
});

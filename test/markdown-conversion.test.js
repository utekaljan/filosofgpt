'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeMarkdown } = require('../src/pipeline/conversion/convert-books');

test('normalizes Markdown safely without stripping its structure', () => {
    const input = [
        '# Title',
        '',
        'A **bold** paragraph with a [source](https://example.test).',
        '',
        '',
        'A second paragraph with a control character.\u0000'
    ].join('\r\n');

    assert.equal(
        normalizeMarkdown(input),
        '# Title\n\nA **bold** paragraph with a [source](https://example.test).\n\n\nA second paragraph with a control character.\n'
    );
});

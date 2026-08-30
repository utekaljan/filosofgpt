'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    inspectMarkdownQuality,
    isSeverelyCorruptedLine,
    removeSeverelyCorruptedPassages
} = require('../src/lib/markdown-quality');

test('keeps readable OCR prose with isolated replacement characters', () => {
    const line = 'The fi�tional compass remains readable while this wholly synthetic sentence explains the test clearly.';
    assert.equal(isSeverelyCorruptedLine(line), false);
    assert.equal(removeSeverelyCorruptedPassages(line).text, line);
});

test('drops a destroyed graph row without rejecting the surrounding book', () => {
    const graph = 'SYNTHETIC-GRID :: �������� :: ////\\\\ :: ...;;;:::###';
    const source = `Readable paragraph before the graph.\n\n${graph}\n\nReadable paragraph after the graph.`;
    const result = removeSeverelyCorruptedPassages(source);
    assert.equal(result.removedLineCount, 1);
    assert.doesNotMatch(result.text, /����/);
    assert.match(result.text, /before the graph/);
    assert.match(result.text, /after the graph/);
});

test('heavy mojibake is an informational warning, not a hard exclusion', () => {
    const text = `${'readable '.repeat(400)}${'� '.repeat(30)}`;
    const quality = inspectMarkdownQuality(text);
    assert.deepEqual(quality.hardReasons, []);
    assert.deepEqual(quality.warnings, ['heavy_mojibake']);
});

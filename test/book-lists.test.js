'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { renderBookList, sortedEntries } = require('../src/pipeline/packaging/generate-book-lists');

test('sorts book lists by Czech author name and then title', () => {
    const entries = [
        { id: '3', author: 'Fixture Author Beta', title: 'Synthetic Work Gamma' },
        { id: '2', author: 'Fixture Author Alpha', title: 'Synthetic Work Beta' },
        { id: '1', author: 'Fixture Author Alpha', title: 'Synthetic Work Alpha' }
    ];

    assert.deepEqual(sortedEntries(entries).map(entry => entry.id), ['1', '2', '3']);
    const rendered = renderBookList('FilosofGPT', 'VYŘAZENÉ KNIHY', [
        { ...entries[0], reason: 'capacity' }
    ], { includeReason: true });
    assert.match(rendered, /Fixture Author Beta\n  - Synthetic Work Gamma \[capacity\]/);
});

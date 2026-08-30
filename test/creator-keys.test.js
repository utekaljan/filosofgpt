'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { contributorKeys, leadCreatorKey } = require('../src/lib/corpus-pipeline');

test('normalizes surname-first aliases and extracts explicit coauthors', () => {
    assert.equal(leadCreatorKey('Author Alpha, Fixture'), 'fixture author alpha');
    assert.equal(leadCreatorKey('Fixture Author Alpha'), 'fixture author alpha');
    assert.deepEqual(
        contributorKeys('Fixture Author Alpha, Fixture Author Beta and Fixture Author Gamma'),
        ['fixture author alpha', 'fixture author beta', 'fixture author gamma']
    );
});

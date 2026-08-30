'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildMergedFileName,
    contributorSurnames,
    maximumMergedFileNameLength
} = require('../src/lib/merged-file-names');

test('builds bounded deterministic merged names from the dominant author surnames', () => {
    const bucket = { units: [
        { author: 'Fixture Author Alpha', bytes: 9000 },
        { author: 'Fixture Author Beta', bytes: 7000 },
        { author: 'Fixture Author Alpha; Fixture Author Gamma (ed.)', bytes: 2000 },
        { author: 'An Author WithAnUnreasonablyLongSurnameThatMustNeverOverflowTheConfiguredFileNameLimit', bytes: 1 }
    ] };

    const name = buildMergedFileName(bucket, 0);
    assert.equal(name, '01_alpha_beta_gamma.md');
    assert.ok(name.length <= maximumMergedFileNameLength);
    assert.deepEqual(contributorSurnames('Fixture Author Alpha; Fixture Author Beta and Fixture Author Gamma'), [
        'alpha', 'beta', 'gamma'
    ]);
});

test('truncates a single extreme surname without exceeding the full filename limit', () => {
    const name = buildMergedFileName({ units: [{ author: `Fixture ${'X'.repeat(200)}`, bytes: 1 }] }, 17);
    assert.equal(name.startsWith('18_'), true);
    assert.equal(name.endsWith('.md'), true);
    assert.ok(name.length <= maximumMergedFileNameLength);
});

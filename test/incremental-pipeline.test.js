'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildCandidates } = require('../src/pipeline/catalog/inventory-books');
const { planConversionCandidates } = require('../src/lib/conversion-planner');

function inventoryFile(id, title) {
    return {
        id,
        relativePath: `Author/${id}/${title}.md`,
        extension: '.md',
        size: 1000,
        sha256: `${id}-sha`,
        metadata: {},
        hints: { author: 'Author', title, rawBase: title, context: 'Author' },
        workHintKey: `author|${title.toLowerCase()}`
    };
}

function curatedWork(id, overrides = {}) {
    return {
        id,
        author: overrides.author || `Author ${id}`,
        title: overrides.title || id,
        contentType: 'book',
        summaryCz: 'Shrnutí.',
        relevanceScore: overrides.relevanceScore ?? 90,
        priorityScore: overrides.priorityScore ?? 90,
        comparativePriority: overrides.comparativePriority ?? 85,
        portfolioRole: overrides.portfolioRole || 'core',
        authorRank: 1,
        creatorKey: overrides.creatorKey || id,
        creatorWorkCount: 1,
        bundleLikeOrigin: false,
        canonicalWorkId: id,
        containsWorkIds: overrides.containsWorkIds || [],
        containedByWorkIds: overrides.containedByWorkIds || [],
        topicKeys: overrides.topicKeys || ['topic'],
        standaloneValue: overrides.standaloneValue || 'high',
        mustInclude: Boolean(overrides.mustInclude),
        authorSoftMaximum: null,
        selectionSizeTokens: overrides.selectionSizeTokens || 100_000
    };
}

test('adding another source variant preserves the existing candidate id', () => {
    const original = inventoryFile('file-original', 'Stable Book');
    const previous = buildCandidates([original]);
    const betterVariant = inventoryFile('file-better', 'Stable Book');
    const current = buildCandidates([original, betterVariant], previous);

    assert.equal(current.length, 1);
    assert.equal(current[0].id, previous[0].id);
    assert.equal(current[0].variants.length, 2);
});

test('conversion frontier is bounded while always admitting newly added and previously selected works', () => {
    const original = Array.from({ length: 20 }, (_, index) => curatedWork(`work-${index + 1}`, {
        comparativePriority: 100 - index
    }));
    const first = planConversionCandidates({
        works: original,
        atlas: { focus_areas: [{ key: 'topic', weight: 1 }] },
        maximumCandidates: 5,
        previousSelectedIds: []
    });
    assert.equal(first.selected.length, 5);

    const added = curatedWork('new-low-score', { comparativePriority: 1, portfolioRole: 'redundant' });
    const second = planConversionCandidates({
        works: [...original, added],
        atlas: { focus_areas: [{ key: 'topic', weight: 1 }] },
        maximumCandidates: 5,
        previousSelectedIds: ['work-20'],
        previousKnownWorkIds: first.knownWorkIds
    });
    const ids = new Set(second.selected.map(work => work.id));
    assert.ok(ids.has('new-low-score'));
    assert.ok(ids.has('work-20'));
    assert.ok(second.selected.length <= 5);
    assert.equal(second.selected.length + second.excluded.length, 21);
});

test('conversion frontier includes both sides of a plausible containment alternative', () => {
    const collection = curatedWork('complete-works', {
        containsWorkIds: ['important-essay'],
        selectionSizeTokens: 2_000_000,
        comparativePriority: 95
    });
    const essay = curatedWork('important-essay', {
        containedByWorkIds: ['complete-works'],
        selectionSizeTokens: 100_000,
        comparativePriority: 10,
        portfolioRole: 'redundant',
        standaloneValue: 'high'
    });
    const result = planConversionCandidates({
        works: [collection, essay, curatedWork('unrelated')],
        atlas: { focus_areas: [{ key: 'topic', weight: 1 }] },
        maximumCandidates: 2,
        previousSelectedIds: []
    });

    assert.deepEqual(new Set(result.selected.map(work => work.id)), new Set(['complete-works', 'important-essay']));
    assert.deepEqual(result.containmentAlternativeIds, ['complete-works', 'important-essay']);
    assert.ok(result.selected.every(work => work.conversionReason === 'containment_alternative'));
});

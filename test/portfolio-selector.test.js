'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collapseExactDuplicates, selectPortfolio } = require('../src/lib/portfolio-selector');

function book(overrides) {
    return {
        id: overrides.id,
        author: overrides.author,
        title: overrides.title || overrides.id,
        creatorKey: overrides.creatorKey,
        creatorWorkCount: overrides.creatorWorkCount,
        canonicalWorkId: overrides.canonicalWorkId || overrides.id,
        portfolioRole: overrides.portfolioRole || 'core',
        comparativePriority: overrides.comparativePriority ?? 90,
        priorityScore: overrides.priorityScore ?? 90,
        relevanceScore: overrides.relevanceScore ?? 97,
        authorRank: overrides.authorRank ?? 1,
        authorSoftMaximum: overrides.authorSoftMaximum ?? null,
        bundleLikeOrigin: overrides.bundleLikeOrigin ?? false,
        topicKeys: overrides.topicKeys || ['consciousness'],
        containsWorkIds: overrides.containsWorkIds || [],
        containedByWorkIds: overrides.containedByWorkIds || [],
        standaloneValue: overrides.standaloneValue || 'medium',
        mustInclude: overrides.mustInclude || false,
        bytes: overrides.bytes ?? 100,
        tokenCount: overrides.tokenCount ?? 100,
        quality: overrides.quality || { mojibakePerThousandWords: 0 }
    };
}

test('selects rare-topic authors before many marginal books from one bundle', () => {
    const bundled = Array.from({ length: 10 }, (_, index) => book({
        id: `bundle-${index + 1}`,
        author: 'Fixture Author Alpha',
        creatorKey: 'fixture author alpha',
        creatorWorkCount: 10,
        authorRank: index + 1,
        comparativePriority: 97 - index,
        bundleLikeOrigin: true,
        topicKeys: ['classical-foundations']
    }));
    const bridge = book({ id: 'bridge', author: 'Fixture Author Beta', creatorKey: 'fixture author beta', creatorWorkCount: 1, comparativePriority: 91 });
    const measure = book({ id: 'measure', author: 'Fixture Author Delta', creatorKey: 'fixture author delta', creatorWorkCount: 1, comparativePriority: 91 });
    const atlas = { focus_areas: [
        { key: 'consciousness', weight: 5 },
        { key: 'classical-foundations', weight: 2 }
    ] };
    const result = selectPortfolio([...bundled, bridge, measure], atlas, { byteCapacity: 300, tokenCapacity: 300 });
    const selectedIds = new Set(result.selected.map(item => item.id));
    assert.equal(result.selected.length, 3);
    assert.ok(selectedIds.has('bridge'));
    assert.ok(selectedIds.has('measure'));
    assert.equal([...selectedIds].filter(id => id.startsWith('bundle')).length, 1);
});

test('absolute duplicate editions can never consume two selection slots', () => {
    const first = book({ id: 'lantern-a', author: 'Fixture Author Alpha', creatorKey: 'fixture author alpha', creatorWorkCount: 2, canonicalWorkId: 'lantern-a' });
    const translation = book({ id: 'lantern-b', author: 'Fixture Author Alpha', creatorKey: 'fixture author alpha', creatorWorkCount: 2, canonicalWorkId: 'lantern-a' });
    const collapsed = collapseExactDuplicates([first, translation]);
    assert.equal(collapsed.eligible.length, 1);
    assert.equal(collapsed.excluded.length, 1);
    assert.match(collapsed.excluded[0].exclusionReason, /^exact_duplicate:/);
});

test('a must-include standalone work blocks its overlapping collection', () => {
    const collection = book({
        id: 'collected-works', author: 'Editor', creatorKey: 'editor', creatorWorkCount: 1,
        comparativePriority: 55, portfolioRole: 'supporting', topicKeys: ['foundations'],
        containsWorkIds: ['standalone-essay']
    });
    const essay = book({
        id: 'standalone-essay', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 1,
        comparativePriority: 99, portfolioRole: 'essential', topicKeys: ['consciousness'],
        containedByWorkIds: ['collected-works'], mustInclude: true
    });
    const result = selectPortfolio([collection, essay], {
        focus_areas: [{ key: 'foundations', weight: 2 }, { key: 'consciousness', weight: 5 }]
    }, { byteCapacity: 2000, tokenCapacity: 2000 });

    assert.deepEqual(result.selected.map(item => item.id), ['standalone-essay']);
    assert.equal(result.selected[0].mustInclude, true);
    assert.match(result.excluded.find(item => item.id === 'collected-works').exclusionReason, /^content_overlap:/);
});

test('a compact collection can beat its separately available parts without duplicating them', () => {
    const collection = book({
        id: 'compact-collection', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 95, portfolioRole: 'essential', topicKeys: ['mind', 'language'],
        containsWorkIds: ['essay-one', 'essay-two'], tokenCount: 300_000
    });
    const first = book({
        id: 'essay-one', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 20, portfolioRole: 'redundant', authorRank: 2,
        topicKeys: ['mind'], containedByWorkIds: ['compact-collection'], standaloneValue: 'high', tokenCount: 150_000
    });
    const second = book({
        id: 'essay-two', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 15, portfolioRole: 'redundant', authorRank: 3,
        topicKeys: ['language'], containedByWorkIds: ['compact-collection'], standaloneValue: 'high', tokenCount: 150_000
    });
    const result = selectPortfolio([collection, first, second], {
        focus_areas: [{ key: 'mind', weight: 3 }, { key: 'language', weight: 3 }]
    }, { byteCapacity: 1000, tokenCapacity: 1_000_000 });

    assert.deepEqual(result.selected.map(item => item.id), ['compact-collection']);
    assert.ok(result.excluded.every(item => item.exclusionReason.startsWith('content_overlap:')));
});

test('several important small works beat one disproportionately large complete works', () => {
    const collection = book({
        id: 'complete-works', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 95, portfolioRole: 'core', topicKeys: ['politics', 'ethics'],
        containsWorkIds: ['politics', 'ethics'], tokenCount: 5_500_000
    });
    const politics = book({
        id: 'politics', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 18, portfolioRole: 'redundant', authorRank: 2,
        topicKeys: ['politics'], containedByWorkIds: ['complete-works'], standaloneValue: 'high', tokenCount: 300_000
    });
    const ethics = book({
        id: 'ethics', author: 'Thinker', creatorKey: 'thinker', creatorWorkCount: 3,
        comparativePriority: 17, portfolioRole: 'redundant', authorRank: 3,
        topicKeys: ['ethics'], containedByWorkIds: ['complete-works'], standaloneValue: 'high', tokenCount: 300_000
    });
    const result = selectPortfolio([collection, politics, ethics], {
        focus_areas: [{ key: 'politics', weight: 3 }, { key: 'ethics', weight: 3 }]
    }, { byteCapacity: 1000, tokenCapacity: 6_000_000 });

    assert.deepEqual(new Set(result.selected.map(item => item.id)), new Set(['politics', 'ethics']));
    assert.match(result.excluded.find(item => item.id === 'complete-works').exclusionReason, /^content_overlap:/);
    assert.ok(result.selected.every(item => item.selectionComponents.collectionSize === 0));
});

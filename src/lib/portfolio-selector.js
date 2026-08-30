'use strict';

const roleWeight = {
    essential: 42,
    core: 28,
    strong: 16,
    supporting: 5,
    specialized: -6,
    redundant: -45
};

const sizeReferenceTokens = 250_000;
// The normal penalty accounts for the opportunity cost of every large work.
// Collections get an extra penalty because their broad inherited coverage can
// otherwise dominate several independently valuable, much smaller works.
const sizePenaltyPerDoubling = 6;
const collectionSizePenaltyPerDoubling = 14;

function roleValue(role) {
    return roleWeight[role] || 0;
}

function strongerRole(left, right) {
    return roleValue(left) >= roleValue(right) ? left : right;
}

function representativeCompare(a, b) {
    return (
        Number(b.mustInclude) - Number(a.mustInclude) ||
        roleValue(b.selectionPortfolioRole || b.portfolioRole) - roleValue(a.selectionPortfolioRole || a.portfolioRole) ||
        (b.selectionComparativePriority ?? b.comparativePriority) - (a.selectionComparativePriority ?? a.comparativePriority) ||
        (a.quality?.mojibakePerThousandWords || 0) - (b.quality?.mojibakePerThousandWords || 0) ||
        b.relevanceScore - a.relevanceScore ||
        a.bytes - b.bytes ||
        a.title.localeCompare(b.title)
    );
}

function collapseExactDuplicates(books) {
    const groups = new Map();
    for (const book of books) {
        const key = book.canonicalWorkId || book.id;
        groups.set(key, [...(groups.get(key) || []), book]);
    }
    const eligible = [];
    const excluded = [];
    for (const group of groups.values()) {
        const ordered = [...group].sort(representativeCompare);
        eligible.push(ordered[0]);
        ordered.slice(1).forEach(book => excluded.push({
            ...book,
            exclusionReason: `exact_duplicate:${ordered[0].id}`
        }));
    }
    return { eligible, excluded };
}

function prepareContainmentAlternatives(books) {
    const byId = new Map(books.map(book => [book.id, { ...book }]));
    const children = new Map([...byId.keys()].map(id => [id, new Set()]));
    const parents = new Map([...byId.keys()].map(id => [id, new Set()]));
    const addRelation = (containerId, childId) => {
        if (containerId === childId || !byId.has(containerId) || !byId.has(childId)) return;
        children.get(containerId).add(childId);
        parents.get(childId).add(containerId);
    };
    for (const book of byId.values()) {
        for (const childId of book.containsWorkIds || []) addRelation(book.id, childId);
        for (const parentId of book.containedByWorkIds || []) addRelation(parentId, book.id);
    }

    const visitState = new Map();
    const descendantMemo = new Map();
    const descendantsOf = id => {
        if (descendantMemo.has(id)) return descendantMemo.get(id);
        const state = visitState.get(id) || 0;
        if (state === 1) throw new Error(`Containment cycle detected at ${id}.`);
        visitState.set(id, 1);
        const descendants = new Set();
        for (const childId of children.get(id) || []) {
            descendants.add(childId);
            for (const descendantId of descendantsOf(childId)) descendants.add(descendantId);
        }
        visitState.set(id, 2);
        descendantMemo.set(id, descendants);
        return descendants;
    };
    for (const id of byId.keys()) descendantsOf(id);

    const ancestorMemo = new Map();
    const ancestorsOf = id => {
        if (ancestorMemo.has(id)) return ancestorMemo.get(id);
        const ancestors = new Set();
        for (const parentId of parents.get(id) || []) {
            ancestors.add(parentId);
            for (const ancestorId of ancestorsOf(parentId)) ancestors.add(ancestorId);
        }
        ancestorMemo.set(id, ancestors);
        return ancestors;
    };
    for (const id of byId.keys()) ancestorsOf(id);

    for (const [id, book] of byId) {
        const ancestorIds = [...ancestorsOf(id)].sort();
        const descendantIds = [...descendantsOf(id)].sort();
        const ancestorPriority = ancestorIds.reduce((maximum, ancestorId) => (
            Math.max(maximum, byId.get(ancestorId)?.comparativePriority ?? 0)
        ), 0);
        let effectivePriority = book.comparativePriority;
        let effectiveRole = book.portfolioRole;
        if (ancestorIds.length && book.standaloneValue === 'high') {
            const rankPenalty = Math.min(36, Math.max(0, (book.authorRank || 1) - 1) * 3);
            effectivePriority = Math.max(effectivePriority, ancestorPriority - rankPenalty);
            effectiveRole = strongerRole(effectiveRole, 'strong');
        }
        book.containsWorkIds = [...children.get(id)].sort();
        book.containedByWorkIds = [...parents.get(id)].sort();
        book.containmentAncestorIds = ancestorIds;
        book.containmentDescendantIds = descendantIds;
        book.contentIdentityIds = [id, ...descendantIds].sort();
        book.selectionComparativePriority = Math.max(0, Math.min(100, effectivePriority));
        book.selectionPortfolioRole = effectiveRole;
    }
    return [...byId.values()];
}

// Compatibility wrapper for older callers. Contained works are no longer
// discarded; the whole and its parts form mutually exclusive alternatives.
function collapseContainedWorks(books) {
    return { eligible: prepareContainmentAlternatives(books), excluded: [] };
}

function selectionSizePenalty(book) {
    const tokens = Math.max(1, book.selectionSizeTokens ?? book.tokenCount ?? 1);
    const doublings = Math.max(0, Math.log2(tokens / sizeReferenceTokens));
    return {
        size: -sizePenaltyPerDoubling * doublings,
        collectionSize: book.containmentDescendantIds?.length
            ? -collectionSizePenaltyPerDoubling * doublings
            : 0
    };
}

function createSelectionState() {
    return {
        selected: [],
        selectedIds: new Set(),
        selectedContentIds: new Set(),
        authorCounts: new Map(),
        topicCounts: new Map(),
        topicAuthors: new Map(),
        usedBytes: 0,
        usedTokens: 0
    };
}

function marginalUtility(book, state, atlas) {
    const creatorSelected = state.authorCounts.get(book.creatorKey) || 0;
    const softMaximum = book.authorSoftMaximum || Number.POSITIVE_INFINITY;
    const sizePenalty = selectionSizePenalty(book);
    const components = {
        comparative: book.selectionComparativePriority ?? book.comparativePriority,
        role: roleValue(book.selectionPortfolioRole || book.portfolioRole),
        relevance: Math.max(0, book.relevanceScore - 70) * 0.18,
        mustInclude: book.mustInclude ? 100 : 0,
        rarity: 25 / Math.sqrt(Math.max(1, book.creatorWorkCount)),
        authorRank: -Math.min(24, Math.max(0, book.authorRank - 1) * 0.55),
        authorSaturation: -9 * Math.pow(creatorSelected, 1.55),
        authorSoftMaximum: creatorSelected >= softMaximum ? -30 * (creatorSelected - softMaximum + 1) : 0,
        bundleSaturation: book.bundleLikeOrigin && creatorSelected > 0 ? -5 : 0,
        topicNovelty: 0,
        standaloneAlternative: book.containmentAncestorIds?.length
            ? ({ high: 6, medium: 0, low: -10 }[book.standaloneValue] || 0)
            : 0,
        size: sizePenalty.size,
        collectionSize: sizePenalty.collectionSize
    };
    const focusByKey = new Map((atlas?.focus_areas || []).map(area => [area.key, area]));
    for (const topic of book.topicKeys || []) {
        const area = focusByKey.get(topic);
        const weight = area?.weight || 1;
        const selectedCount = state.topicCounts.get(topic) || 0;
        const authors = state.topicAuthors.get(topic) || new Set();
        components.topicNovelty += weight * (selectedCount === 0 ? 9 : selectedCount === 1 ? 4 : 1.5 / Math.sqrt(selectedCount));
        if (!authors.has(book.creatorKey)) components.topicNovelty += weight * 2.5;
    }
    if (!book.topicKeys?.length) components.topicNovelty -= 5;
    const total = Object.values(components).reduce((sum, value) => sum + value, 0);
    return { total, components };
}

function canFit(book, state, limits) {
    return (
        book.bytes <= limits.byteCapacity - state.usedBytes &&
        book.tokenCount <= limits.tokenCapacity - state.usedTokens
    );
}

function overlappingSelectedIds(book, state) {
    const identities = new Set(book.contentIdentityIds || [book.id]);
    return state.selected
        .filter(selected => (selected.contentIdentityIds || [selected.id]).some(id => identities.has(id)))
        .map(selected => selected.id);
}

function hasContentOverlap(book, state) {
    return (book.contentIdentityIds || [book.id]).some(id => state.selectedContentIds.has(id));
}

function addSelected(book, score, state) {
    state.selected.push({ ...book, selectionScore: score.total, selectionComponents: score.components });
    state.selectedIds.add(book.id);
    for (const id of book.contentIdentityIds || [book.id]) state.selectedContentIds.add(id);
    state.usedBytes += book.bytes;
    state.usedTokens += book.tokenCount;
    state.authorCounts.set(book.creatorKey, (state.authorCounts.get(book.creatorKey) || 0) + 1);
    for (const topic of book.topicKeys || []) {
        state.topicCounts.set(topic, (state.topicCounts.get(topic) || 0) + 1);
        const authors = state.topicAuthors.get(topic) || new Set();
        authors.add(book.creatorKey);
        state.topicAuthors.set(topic, authors);
    }
}

function rankPortfolioCandidates(books, atlas) {
    const prepared = prepareContainmentAlternatives(books);
    const state = createSelectionState();
    return prepared.map(book => ({ book, score: marginalUtility(book, state, atlas) }))
        .sort((a, b) => (
            b.score.total - a.score.total ||
            b.book.selectionComparativePriority - a.book.selectionComparativePriority ||
            (a.book.selectionSizeTokens ?? a.book.tokenCount) - (b.book.selectionSizeTokens ?? b.book.tokenCount) ||
            a.book.title.localeCompare(b.book.title)
        ));
}

function selectPortfolio(books, atlas, limits, options = {}) {
    const duplicatesCollapsed = collapseExactDuplicates(books);
    const prepared = prepareContainmentAlternatives(duplicatesCollapsed.eligible);
    const state = createSelectionState();
    const remaining = new Map(prepared.map(book => [book.id, book]));
    const excluded = [...duplicatesCollapsed.excluded];
    const mustInclude = [...remaining.values()].filter(book => book.mustInclude).sort(representativeCompare);
    for (const book of mustInclude) {
        const score = marginalUtility(book, state, atlas);
        if (hasContentOverlap(book, state)) {
            excluded.push({
                ...book,
                exclusionReason: `must_include_content_overlap:${overlappingSelectedIds(book, state).join(',')}`,
                selectionScore: score.total,
                selectionComponents: score.components
            });
        } else if (canFit(book, state, limits)) {
            addSelected(book, score, state);
        } else {
            excluded.push({ ...book, exclusionReason: 'must_include_over_capacity', selectionScore: score.total });
        }
        remaining.delete(book.id);
    }
    const minimumUtility = options.minimumUtility ?? 10;
    while (remaining.size > 0) {
        const ranked = [...remaining.values()].map(book => ({
            book,
            score: marginalUtility(book, state, atlas)
        })).sort((a, b) => (
            b.score.total - a.score.total ||
            b.book.selectionComparativePriority - a.book.selectionComparativePriority ||
            a.book.tokenCount - b.book.tokenCount ||
            a.book.title.localeCompare(b.book.title)
        ));
        const next = ranked.find(item => !hasContentOverlap(item.book, state) && canFit(item.book, state, limits));
        if (!next || next.score.total < minimumUtility) break;
        addSelected(next.book, next.score, state);
        remaining.delete(next.book.id);
    }
    for (const book of remaining.values()) {
        const score = marginalUtility(book, state, atlas);
        const overlappingIds = overlappingSelectedIds(book, state);
        excluded.push({
            ...book,
            exclusionReason: overlappingIds.length
                ? `content_overlap:${overlappingIds.join(',')}`
                : canFit(book, state, limits) ? 'marginal_value' : 'capacity',
            selectionScore: score.total,
            selectionComponents: score.components
        });
    }
    return {
        selected: state.selected,
        excluded,
        byteCapacity: limits.byteCapacity,
        tokenCapacity: limits.tokenCapacity,
        usedBytes: state.usedBytes,
        usedTokens: state.usedTokens
    };
}

module.exports = {
    collapseContainedWorks,
    collapseExactDuplicates,
    marginalUtility,
    prepareContainmentAlternatives,
    rankPortfolioCandidates,
    roleWeight,
    selectPortfolio
};

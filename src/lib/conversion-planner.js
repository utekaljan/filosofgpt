'use strict';

const {
    rankPortfolioCandidates,
    selectPortfolio
} = require('./portfolio-selector');

function uniqueExistingIds(ids, byId) {
    return [...new Set(ids || [])].filter(id => byId.has(id));
}

function planConversionCandidates({
    works,
    atlas,
    maximumCandidates,
    previousSelectedIds = [],
    previousKnownWorkIds = null
}) {
    const orderedWorks = [...works].sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(orderedWorks.map(work => [work.id, work]));
    const previousKnown = previousKnownWorkIds ? new Set(previousKnownWorkIds) : null;
    const newlyAddedIds = previousKnown
        ? orderedWorks.filter(work => !previousKnown.has(work.id)).map(work => work.id)
        : [];
    const requiredIds = uniqueExistingIds([
        ...orderedWorks.filter(work => work.mustInclude).map(work => work.id),
        ...previousSelectedIds,
        ...newlyAddedIds
    ], byId);

    const pseudoBooks = orderedWorks.map(work => ({
        ...work,
        bytes: 1,
        tokenCount: 1,
        selectionSizeTokens: work.selectionSizeTokens || 1,
        quality: { mojibakePerThousandWords: 0 }
    }));
    const staticRanking = rankPortfolioCandidates(pseudoBooks, atlas);
    const preparedById = new Map(staticRanking.map(item => [item.book.id, item.book]));
    const containmentAlternativeIds = new Set();
    for (const { book } of staticRanking) {
        if (!book.containmentAncestorIds.length || book.standaloneValue !== 'high') continue;
        const childSize = book.selectionSizeTokens || 1;
        const ancestors = book.containmentAncestorIds.map(id => preparedById.get(id)).filter(Boolean);
        if (ancestors.some(ancestor => ancestor.mustInclude)) continue;
        const smallestAncestorSize = Math.min(...ancestors.map(ancestor => ancestor.selectionSizeTokens || 1));
        if (childSize >= smallestAncestorSize) continue;
        containmentAlternativeIds.add(book.id);
        ancestors
            .filter(ancestor => (ancestor.selectionSizeTokens || 1) <= smallestAncestorSize * 1.05)
            .forEach(ancestor => containmentAlternativeIds.add(ancestor.id));
    }
    const frontier = selectPortfolio(
        pseudoBooks,
        atlas,
        {
            byteCapacity: Math.max(1, maximumCandidates),
            tokenCapacity: Math.max(1, maximumCandidates)
        },
        { minimumUtility: Number.NEGATIVE_INFINITY }
    );
    const hardRequiredIds = new Set(requiredIds);
    const selectionLimit = Math.max(maximumCandidates, hardRequiredIds.size);
    const selectedIds = new Set(requiredIds);
    const addUntilLimit = ids => {
        for (const id of ids) {
            if (selectedIds.size >= selectionLimit) break;
            if (byId.has(id)) selectedIds.add(id);
        }
    };
    addUntilLimit(staticRanking
        .map(item => item.book.id)
        .filter(id => containmentAlternativeIds.has(id)));
    addUntilLimit(frontier.selected.map(work => work.id));
    addUntilLimit(staticRanking.map(item => item.book.id));
    const reasonById = new Map();
    for (const id of frontier.selected.map(work => work.id)) reasonById.set(id, 'curation_frontier');
    for (const id of containmentAlternativeIds) if (selectedIds.has(id)) reasonById.set(id, 'containment_alternative');
    for (const id of previousSelectedIds) if (byId.has(id)) reasonById.set(id, 'previous_final_selection');
    for (const id of newlyAddedIds) reasonById.set(id, 'newly_added_work');
    for (const work of orderedWorks.filter(work => work.mustInclude)) reasonById.set(work.id, 'must_include');

    const selected = orderedWorks
        .filter(work => selectedIds.has(work.id))
        .map(work => ({ ...work, conversionReason: reasonById.get(work.id) || 'curation_frontier' }));
    const excluded = orderedWorks
        .filter(work => !selectedIds.has(work.id))
        .map(work => ({ ...work, exclusionReason: 'preconversion_marginal_value' }));

    return {
        maximumCandidates,
        effectiveMaximumCandidates: selectionLimit,
        totalEligibleWorkCount: orderedWorks.length,
        selected,
        excluded,
        containmentAlternativeIds: [...containmentAlternativeIds].filter(id => selectedIds.has(id)).sort(),
        newlyAddedIds,
        previousSelectedIds: uniqueExistingIds(previousSelectedIds, byId),
        knownWorkIds: orderedWorks.map(work => work.id)
    };
}

module.exports = {
    planConversionCandidates
};

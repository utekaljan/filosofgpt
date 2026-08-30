'use strict';

const fs = require('fs');
const path = require('path');
const {
    config,
    ensureDirectory,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath,
    sanitizeFilePart,
    stableHash,
    writeJsonAtomicIfChanged
} = require('../../lib/corpus-pipeline');
const { planConversionCandidates } = require('../../lib/conversion-planner');
const { progressLog, ProgressTracker } = require('../../lib/progress');

const stateDir = resolveProjectPath(config.stateDir);
const sourceDir = resolveProjectPath(config.sourceDir);
const booksDir = resolveProjectPath(config.booksDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const catalogPath = path.join(stateDir, 'catalog.json');
const portfolioPath = path.join(stateDir, 'curation', 'portfolio.json');
const conversionPlanDir = path.join(stateDir, 'conversion-plans');
const allowPartial = process.argv.includes('--allow-partial');
const copyMode = process.argv.includes('--copy');
const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.slice('--corpus='.length);
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;

function uniqueOutputName(work, source, usedNames) {
    const extension = source.extension.toLowerCase();
    const author = sanitizeFilePart(work.author || 'Unknown', 70);
    const title = sanitizeFilePart(work.title, 120);
    const base = sanitizeFilePart(`${author} - ${title}`, 190);
    let candidate = `${base}${extension}`;
    if (!usedNames.has(candidate.toLowerCase())) {
        usedNames.add(candidate.toLowerCase());
        return candidate;
    }

    candidate = `${base} [${work.id.slice(-8)}]${extension}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
}

function materialize(sourcePath, destinationPath) {
    if (copyMode) {
        fs.copyFileSync(sourcePath, destinationPath);
        return 'copy';
    }
    try {
        fs.linkSync(sourcePath, destinationPath);
        return 'hardlink';
    } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'EMLINK'].includes(error.code)) {
            throw error;
        }
        fs.copyFileSync(sourcePath, destinationPath);
        return 'copy-fallback';
    }
}

function materializeIncrementally(sourcePath, destinationPath, previousEntry, selectedSource) {
    if (
        previousEntry?.sourceRelativePath === selectedSource.relativePath &&
        previousEntry?.sha256 === selectedSource.sha256 &&
        fs.existsSync(destinationPath)
    ) {
        return 'reused';
    }
    fs.rmSync(destinationPath, { force: true });
    return materialize(sourcePath, destinationPath);
}

function planningWork(work, curated) {
    return {
        id: work.id,
        author: work.author,
        title: work.title,
        contentType: work.contentType,
        relevanceScore: work.relevanceScore,
        priorityScore: work.priorityScore,
        comparativePriority: curated.comparativePriority,
        portfolioRole: curated.portfolioRole,
        authorRank: curated.authorRank,
        creatorKey: curated.creatorKey,
        creatorWorkCount: curated.creatorWorkCount,
        bundleLikeOrigin: curated.bundleLikeOrigin,
        canonicalWorkId: curated.canonicalWorkId,
        containsWorkIds: curated.containsWorkIds,
        containedByWorkIds: curated.containedByWorkIds,
        topicKeys: curated.topicKeys,
        standaloneValue: curated.standaloneValue,
        mustInclude: curated.mustInclude,
        mustIncludeReasonCz: curated.mustIncludeReasonCz,
        subsumedWorkIds: curated.subsumedWorkIds || [],
        authorSoftMaximum: curated.authorSoftMaximum,
        // Before conversion we only have the source size. It is deliberately
        // used for ranking, never as proof of an upload-token limit.
        selectionSizeTokens: Math.max(1, Math.ceil((work.primarySource?.size || 1) / 4))
    };
}

function organizeCorpus(catalog, portfolioDocument, corpus) {
    const corpusDir = path.join(booksDir, corpus);
    ensureDirectory(corpusDir);
    const curation = portfolioDocument.corpora?.[corpus];
    if (!curation?.works || curation.incomplete) {
        throw new Error(`Missing complete curation portfolio for ${corpus}; run node src/pipeline/prioritization/curate-corpora.js.`);
    }
    const curationById = new Map(curation.works.map(entry => [entry.workId, entry]));
    const eligibleWorks = catalog.works.filter(work => (
        work.target === corpus &&
        !curationById.get(work.id)?.exactDuplicate
    ));
    const planningWorks = eligibleWorks.map(work => planningWork(work, curationById.get(work.id)));
    const planPath = path.join(conversionPlanDir, `${corpus}.json`);
    const previousPlan = readJsonIfExists(planPath);
    const previousMerge = readJsonIfExists(path.join(reportsDir, 'merge', `${corpus}.json`), { selected: [] });
    const conversionPlan = planConversionCandidates({
        works: planningWorks,
        atlas: curation.atlas,
        maximumCandidates: config.conversion.maxCandidatesPerCorpus,
        previousSelectedIds: (previousMerge.selected || []).map(entry => entry.id),
        // Version 1 plans omitted every contained work. During the one-time
        // migration to alternatives they must not masquerade as newly added
        // books; version 2 records the complete eligible set for later runs.
        previousKnownWorkIds: previousPlan?.version >= 2
            ? previousPlan.knownWorkIds
            : previousPlan ? planningWorks.map(work => work.id) : null
    });
    const selectedIds = new Set(conversionPlan.selected.map(work => work.id));
    const works = eligibleWorks.filter(work => selectedIds.has(work.id));
    const selectedPlanById = new Map(conversionPlan.selected.map(work => [work.id, work]));
    const previousManifest = readJsonIfExists(path.join(corpusDir, 'manifest.json'), { entries: [] });
    const previousEntryById = new Map((previousManifest.entries || []).map(entry => [entry.workId, entry]));
    const usedNames = new Set();
    const entries = [];
    const progress = new ProgressTracker({ scope: `organize:${corpus}`, total: works.length });
    progressLog(
        `organize:${corpus}`,
        `materializing conversion frontier ${works.length}/${eligibleWorks.length} non-duplicate works into ${path.relative(projectRoot, corpusDir)}; newly-added=${conversionPlan.newlyAddedIds.length}; containment-alternatives=${conversionPlan.containmentAlternativeIds.length}`
    );

    try {
        for (const work of works) {
            const selectedSource = work.primarySource;
            if (!selectedSource) {
                throw new Error(`Missing primary source for ${work.id}.`);
            }
            const sourcePath = path.join(sourceDir, selectedSource.relativePath);
            if (!fs.existsSync(sourcePath)) {
                throw new Error(`Selected source is missing: ${sourcePath}`);
            }
            const outputName = uniqueOutputName(work, selectedSource, usedNames);
            const outputPath = path.join(corpusDir, outputName);
            const previousEntry = previousEntryById.get(work.id);
            const materialization = materializeIncrementally(
                sourcePath,
                outputPath,
                previousEntry?.outputName === outputName ? previousEntry : null,
                selectedSource
            );
            const curated = curationById.get(work.id);
            if (!curated) throw new Error(`Missing curation entry for ${work.id}.`);
            entries.push({
            workId: work.id,
            author: work.author,
            title: work.title,
            summaryCz: work.summaryCz,
            contentType: work.contentType,
            language: work.language,
            relevanceScore: work.relevanceScore,
            priorityScore: work.priorityScore,
            comparativePriority: curated.comparativePriority,
            portfolioRole: curated.portfolioRole,
            authorRank: curated.authorRank,
            creatorKey: curated.creatorKey,
            creatorWorkCount: curated.creatorWorkCount,
            bundleLikeOrigin: curated.bundleLikeOrigin,
            canonicalWorkId: curated.canonicalWorkId,
            identityGroupKey: curated.identityGroupKey,
            editionGroupKey: curated.editionGroupKey,
            scope: curated.scope,
            containsWorkIds: curated.containsWorkIds,
            containedByWorkIds: curated.containedByWorkIds,
            topicKeys: curated.topicKeys,
            standaloneValue: curated.standaloneValue,
            mustInclude: curated.mustInclude,
            mustIncludeReasonCz: curated.mustIncludeReasonCz,
            subsumedWorkIds: curated.subsumedWorkIds || [],
            authorSoftMaximum: curated.authorSoftMaximum,
            curationReasonCz: curated.reasonCz,
            sourceRelativePath: selectedSource.relativePath,
            alternateSources: work.sourceVariants.filter(source => source.fileId !== selectedSource.fileId).map(source => source.relativePath),
            outputName,
            bytes: selectedSource.size,
            sha256: selectedSource.sha256,
            conversionReason: selectedPlanById.get(work.id)?.conversionReason || 'curation_frontier',
                materialization
            });
            progress.advance(`${work.author} — ${work.title}`);
        }
    } finally {
        progress.dispose();
    }

    const desiredNames = new Set(entries.map(entry => entry.outputName));
    for (const directoryEntry of fs.readdirSync(corpusDir, { withFileTypes: true })) {
        if (
            directoryEntry.isFile() &&
            directoryEntry.name !== 'manifest.json' &&
            !desiredNames.has(directoryEntry.name)
        ) {
            fs.rmSync(path.join(corpusDir, directoryEntry.name), { force: true });
        }
    }

    const preconversionExcluded = conversionPlan.excluded.map(entry => ({
        id: entry.id,
        author: entry.author,
        title: entry.title,
        contentType: entry.contentType,
        portfolioRole: entry.portfolioRole,
        comparativePriority: entry.comparativePriority,
        priorityScore: entry.priorityScore,
        relevanceScore: entry.relevanceScore,
        authorRank: entry.authorRank,
        creatorKey: entry.creatorKey,
        creatorWorkCount: entry.creatorWorkCount,
        topicKeys: entry.topicKeys,
        mustInclude: entry.mustInclude,
        reason: entry.exclusionReason
    }));

    const manifest = {
        generatedAt: new Date().toISOString(),
        corpus,
        workCount: entries.length,
        totalEligibleWorkCount: eligibleWorks.length,
        preconversionExcludedCount: preconversionExcluded.length,
        totalSourceBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        materializationMode: copyMode ? 'copy' : 'hardlink-with-copy-fallback',
        curationAtlasHash: curation.atlasHash,
        curationAtlas: curation.atlas,
        conversionPlanHash: stableHash({
            selectedWorkIds: conversionPlan.selected.map(work => work.id),
            knownWorkIds: conversionPlan.knownWorkIds,
            atlasHash: curation.atlasHash
        }),
        entries,
        preconversionExcluded
    };
    const manifestChanged = writeJsonAtomicIfChanged(path.join(corpusDir, 'manifest.json'), manifest);
    writeJsonAtomicIfChanged(planPath, {
        version: 2,
        generatedAt: new Date().toISOString(),
        corpus,
        curationAtlasHash: curation.atlasHash,
        maximumCandidates: conversionPlan.maximumCandidates,
        totalEligibleWorkCount: conversionPlan.totalEligibleWorkCount,
        plannedWorkCount: conversionPlan.selected.length,
        excludedWorkCount: conversionPlan.excluded.length,
        newlyAddedIds: conversionPlan.newlyAddedIds,
        containmentAlternativeIds: conversionPlan.containmentAlternativeIds,
        previousSelectedIds: conversionPlan.previousSelectedIds,
        selectedWorkIds: conversionPlan.selected.map(work => work.id),
        knownWorkIds: conversionPlan.knownWorkIds
    }, ['generatedAt', 'newlyAddedIds', 'previousSelectedIds']);
    progressLog(
        `organize:${corpus}`,
        `complete: ${entries.length}/${eligibleWorks.length} works, ${(manifest.totalSourceBytes / 1024 / 1024 / 1024).toFixed(2)} GiB; manifest=${manifestChanged ? 'updated' : 'unchanged'}`
    );
    return manifest;
}

function main() {
    for (const corpus of corpora) {
        if (!config.corpora.includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
    }
    const catalog = readJsonIfExists(catalogPath);
    if (!catalog || !Array.isArray(catalog.works)) {
        throw new Error(`Run node src/pipeline/catalog/classify-books.js first; missing ${catalogPath}`);
    }
    if (!allowPartial && catalog.summary.unclassifiedCandidateCount > 0) {
        throw new Error(`Classification is incomplete (${catalog.summary.unclassifiedCandidateCount} pending). Use --allow-partial only for a deliberate test.`);
    }
    const portfolioDocument = readJsonIfExists(portfolioPath);
    if (!portfolioDocument?.corpora) {
        throw new Error(`Curation is incomplete or missing: ${portfolioPath}`);
    }

    ensureDirectory(booksDir);
    const manifests = corpora.map(corpus => organizeCorpus(catalog, portfolioDocument, corpus));
    const selectedRedundantWorks = corpora.flatMap(corpus => (
        (portfolioDocument.corpora?.[corpus]?.works || [])
            .filter(work => work.exactDuplicate)
            .map(work => ({
                corpus,
                exclusionType: 'exact_duplicate',
                ...work
            }))
    ));
    const previousRedundancy = readJsonIfExists(path.join(booksDir, 'redundancy-manifest.json'), { entries: [] });
    const redundantWorks = [
        ...(previousRedundancy.entries || []).filter(entry => !corpora.includes(entry.corpus)),
        ...selectedRedundantWorks
    ];
    writeJsonAtomicIfChanged(path.join(booksDir, 'redundancy-manifest.json'), {
        generatedAt: new Date().toISOString(),
        workCount: redundantWorks.length,
        entries: redundantWorks
    });
    const nullWorks = catalog.works.filter(work => work.target === 'null').map(work => ({
        workId: work.id,
        author: work.author,
        title: work.title,
        summaryCz: work.summaryCz,
        reasonCz: work.reasonCz,
        priorityScore: work.priorityScore,
        sourceRelativePath: work.primarySource.relativePath,
        duplicateVariantCount: work.sourceVariants.length
    }));
    writeJsonAtomicIfChanged(path.join(booksDir, 'null-manifest.json'), {
        generatedAt: new Date().toISOString(),
        workCount: nullWorks.length,
        entries: nullWorks
    });

    for (const manifest of manifests) {
        console.log(`${manifest.corpus}: ${manifest.workCount} works, ${(manifest.totalSourceBytes / 1024 / 1024 / 1024).toFixed(2)} GiB source material.`);
    }
    console.log(`null: ${nullWorks.length} works (manifest only).`);
    console.log(`Organized books under ${path.relative(projectRoot, booksDir)}/`);
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

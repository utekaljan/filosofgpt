'use strict';

const fs = require('fs');
const path = require('path');
const { projectRoot } = require('../../lib/corpus-pipeline');
const { countTokens, prefixWithinTokenLimit, tokenCount } = require('../../lib/token-counter');
const {
    countWords,
    inspectMarkdownQuality
} = require('../../lib/markdown-quality');
const { selectPortfolio } = require('../../lib/portfolio-selector');
const { buildMergedFileName } = require('../../lib/merged-file-names');
const { progressLog, ProgressTracker } = require('../../lib/progress');
const {
    applyPartContext,
    extractRetrievalSections,
    transformRetrievalMarkdown,
    validateMergedRetrievalMarkdown
} = require('../../lib/retrieval-markdown');

function resolveConfiguredPath(environmentName, fallback) {
    const configured = process.env[environmentName];
    if (!configured) return path.join(projectRoot, fallback);
    return path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const inputFolder = resolveConfiguredPath('MARKDOWN_INPUT_DIR', 'output/markdown');
const outputFolder = resolveConfiguredPath('MERGED_OUTPUT_DIR', 'output/merged');
const mergeReportFile = resolveConfiguredPath('MERGE_REPORT', 'output/reports/standalone/merge.json');
const manifestFile = process.env.BOOKS_MANIFEST ? resolveConfiguredPath('BOOKS_MANIFEST', '') : '';
const corpusName = process.env.CORPUS_NAME || 'Books';
const maxBookFiles = parsePositiveInt(process.env.MAX_BOOK_FILES, 18);
const maxFileSizeBytes = parsePositiveInt(process.env.MAX_FILE_SIZE_BYTES, 12 * 1024 * 1024);
const preferredFileSizeBytes = Math.min(maxFileSizeBytes, parsePositiveInt(
    process.env.PREFERRED_FILE_SIZE_BYTES,
    11 * 1024 * 1024
));
const maxTokensPerFile = parsePositiveInt(process.env.MAX_TOKENS_PER_FILE, 1_800_000);
const indexMode = process.env.INDEX_MODE || 'embedded-first';
// Packing operates on transformed book units, while the final file also adds
// per-book metadata, local contents and (for file 01) the global index. Keep a
// real reserve for that deterministic retrieval wrapper so a successfully
// packed bucket cannot fail only when it is rendered.
const perFileReserveBytes = Math.min(512 * 1024, Math.floor(maxFileSizeBytes * 0.05));
const usableFileBytes = Math.max(64 * 1024, preferredFileSizeBytes - perFileReserveBytes);
const tokenReserve = Math.min(100_000, Math.floor(maxTokensPerFile * 0.06));
const usableFileTokens = Math.max(10_000, maxTokensPerFile - tokenReserve);
const maximumUnitBytes = Math.max(32 * 1024, Math.floor(usableFileBytes / 2));
const maximumUnitTokens = Math.max(5_000, Math.floor(usableFileTokens / 2));
const minimumUsefulBytes = parsePositiveInt(process.env.MIN_USEFUL_MARKDOWN_BYTES, 2000);

if (indexMode !== 'embedded-first') throw new Error(`Unsupported INDEX_MODE: ${indexMode}`);

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function prepareOutputFolder() {
    fs.mkdirSync(outputFolder, { recursive: true });
    fs.mkdirSync(path.dirname(mergeReportFile), { recursive: true });
}

function selectionIdentity(author, title) {
    return `${String(author || '').trim()}\0${String(title || '').trim()}`;
}

function parseSelectedBookList(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const identities = new Set();
    let author = '';
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const title = line.match(/^  - (.+?)(?: \[[^\]]+\])?$/)?.[1];
        if (title && author) identities.add(selectionIdentity(author, title));
        else if (line && !/^FilosofGPT|^PolyhistorGPT|^Počet knih:|^Řazení:/.test(line) && !/^\s/.test(line)) author = line.trim();
    }
    return identities.size ? { identities, mtimeMs: fs.statSync(filePath).mtimeMs, source: filePath } : null;
}

function loadPriorSelection(manifest, names) {
    const candidates = [];
    if (fs.existsSync(mergeReportFile)) {
        try {
            const report = JSON.parse(fs.readFileSync(mergeReportFile, 'utf8'));
            if (report.curationAtlasHash === manifest.curationAtlasHash && Array.isArray(report.selected) && report.selected.length) {
                candidates.push({
                    identities: new Set(report.selected.map(entry => selectionIdentity(entry.author, entry.title))),
                    mtimeMs: fs.statSync(mergeReportFile).mtimeMs,
                    source: mergeReportFile
                });
            }
        } catch (_) {
            // A malformed cache is ignored; the normal full selection remains available.
        }
    }
    const listPath = path.join(projectRoot, 'output', 'reports', 'book-lists', `${corpusName}-vybrane-knihy.txt`);
    const list = parseSelectedBookList(listPath);
    if (list) candidates.push(list);
    if (!candidates.length) return null;

    const newestInputMtime = Math.max(
        fs.statSync(manifestFile).mtimeMs,
        ...names.map(name => fs.statSync(path.join(inputFolder, name)).mtimeMs)
    );
    const fresh = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).find(candidate => candidate.mtimeMs >= newestInputMtime);
    if (!fresh) return null;

    const manifestIdentities = new Set((manifest.entries || []).map(entry => selectionIdentity(entry.author, entry.title)));
    if ([...fresh.identities].some(identity => !manifestIdentities.has(identity))) return null;
    return fresh;
}

function loadManifest() {
    if (!manifestFile || !fs.existsSync(manifestFile)) return { entries: [], curationAtlas: null };
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    return {
        ...manifest,
        byBaseName: new Map((manifest.entries || []).map(entry => [
            path.basename(entry.outputName, path.extname(entry.outputName)),
            entry
        ]))
    };
}

function loadBooks() {
    const manifest = loadManifest();
    if (!manifest.curationAtlas) throw new Error('Books manifest is missing the global curation atlas.');
    if (!fs.existsSync(inputFolder)) throw new Error(`Markdown input folder does not exist: ${inputFolder}`);
    const names = fs.readdirSync(inputFolder)
        .filter(name => name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.localeCompare(b));
    let priorSelection = loadPriorSelection(manifest, names);
    let selectedNames = priorSelection
        ? names.filter(name => {
            const metadata = manifest.byBaseName.get(path.basename(name, '.md'));
            return metadata && priorSelection.identities.has(selectionIdentity(metadata.author, metadata.title));
        })
        : names;
    if (priorSelection && selectedNames.length !== priorSelection.identities.size) {
        progressLog(
            `merge:${corpusName}`,
            `discarding stale cached selection: ${selectedNames.length}/${priorSelection.identities.size} books still have Markdown`
        );
        priorSelection = null;
        selectedNames = names;
    }
    const progress = new ProgressTracker({ scope: `merge:${corpusName}:load`, total: selectedNames.length });
    progressLog(`merge:${corpusName}`, priorSelection
        ? `reusing validated selection from ${path.relative(projectRoot, priorSelection.source)}; transforming only ${selectedNames.length}/${names.length} books`
        : `no valid prior selection; loading and tokenizing ${names.length} Markdown books`);
    const books = selectedNames.map((name, index) => {
            const progressId = `merge-book-${index}`;
            progress.start(progressId, index + 1, name);
            try {
            const filePath = path.join(inputFolder, name);
            const originalContent = fs.readFileSync(filePath, 'utf8').trim();
            const baseName = path.basename(name, '.md');
            const metadata = manifest.byBaseName.get(baseName);
            if (!metadata) throw new Error(`Markdown has no manifest entry: ${name}`);
            const originalQuality = inspectMarkdownQuality(originalContent, minimumUsefulBytes);
            const quality = originalQuality;
            const bookIdentity = {
                id: metadata.workId,
                author: metadata.author || '',
                title: metadata.title || baseName,
                contentType: metadata.contentType || 'unknown',
                scope: metadata.scope || 'standalone_work'
            };
            const retrieval = transformRetrievalMarkdown(bookIdentity, originalContent);
            const content = retrieval.content;
            const bytes = Buffer.byteLength(content, 'utf8');
            const tokens = countTokens(content);
            return {
                ...bookIdentity,
                summaryCz: metadata.summaryCz || '',
                relevanceScore: metadata.relevanceScore ?? 50,
                priorityScore: metadata.priorityScore ?? 50,
                comparativePriority: metadata.comparativePriority ?? metadata.priorityScore ?? 50,
                portfolioRole: metadata.portfolioRole || 'supporting',
                authorRank: metadata.authorRank || 999,
                creatorKey: metadata.creatorKey || slugify(metadata.author),
                creatorWorkCount: metadata.creatorWorkCount || 1,
                bundleLikeOrigin: Boolean(metadata.bundleLikeOrigin),
                canonicalWorkId: metadata.canonicalWorkId || metadata.workId,
                identityGroupKey: metadata.identityGroupKey || metadata.workId,
                editionGroupKey: metadata.editionGroupKey || metadata.workId,
                containsWorkIds: metadata.containsWorkIds || [],
                containedByWorkIds: metadata.containedByWorkIds || [],
                topicKeys: metadata.topicKeys || [],
                standaloneValue: metadata.standaloneValue || 'medium',
                mustInclude: Boolean(metadata.mustInclude),
                mustIncludeReasonCz: metadata.mustIncludeReasonCz || '',
                subsumedWorkIds: metadata.subsumedWorkIds || [],
                authorSoftMaximum: metadata.authorSoftMaximum,
                curationReasonCz: metadata.curationReasonCz || '',
                fileName: name,
                filePath,
                content,
                bytes,
                words: countWords(originalContent),
                tokenCount: tokens.tokens,
                tokenCounts: tokens.byEncoding,
                quality,
                originalQuality,
                postprocessing: {
                    removedCorruptedLines: 0,
                    removedCorruptedBytes: 0
                },
                retrieval
            };
            } finally {
                progress.complete(progressId, 'tokenized');
            }
        });
    progress.dispose();
    const loadedIds = new Set(books.map(book => book.id));
    const markdownWorkIds = new Set(names
        .map(name => manifest.byBaseName.get(path.basename(name, '.md'))?.workId)
        .filter(Boolean));
    const stagedDeferred = priorSelection ? names
        .map(name => manifest.byBaseName.get(path.basename(name, '.md')))
        .filter(entry => entry && !loadedIds.has(entry.workId))
        .map(entry => ({
            id: entry.workId,
            author: entry.author,
            title: entry.title,
            contentType: entry.contentType,
            portfolioRole: entry.portfolioRole,
            comparativePriority: entry.comparativePriority,
            priorityScore: entry.priorityScore,
            relevanceScore: entry.relevanceScore,
            fileName: path.basename(entry.outputName, path.extname(entry.outputName)) + '.md',
            exclusionReason: 'prior_portfolio_exclusion'
        })) : [];
    const missingConversions = (manifest.entries || [])
        .filter(entry => !markdownWorkIds.has(entry.workId))
        .map(entry => ({
            id: entry.workId,
            author: entry.author,
            title: entry.title,
            contentType: entry.contentType,
            portfolioRole: entry.portfolioRole,
            comparativePriority: entry.comparativePriority,
            priorityScore: entry.priorityScore,
            relevanceScore: entry.relevanceScore,
            fileName: path.basename(entry.outputName, path.extname(entry.outputName)) + '.md',
            exclusionReason: 'conversion_failed'
        }));
    const deferredById = new Map((manifest.preconversionExcluded || []).map(entry => [entry.id, {
        ...entry,
        exclusionReason: entry.reason || 'preconversion_marginal_value'
    }]));
    for (const entry of stagedDeferred) deferredById.set(entry.id, entry);
    for (const entry of missingConversions) deferredById.set(entry.id, entry);
    return {
        books,
        atlas: manifest.curationAtlas,
        manifest,
        deferred: [...deferredById.values()],
        inputBookCount: manifest.totalEligibleWorkCount || names.length,
        conversionCandidateCount: names.length,
        priorSelection
    };
}

function prefixWithinLimits(text, maximumBytes, maximumTokens) {
    let high = Math.min(text.length, prefixWithinTokenLimit(text, maximumTokens));
    let low = 0;
    while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= maximumBytes) low = middle;
        else high = middle;
    }
    if (Buffer.byteLength(text.slice(0, high), 'utf8') <= maximumBytes) return high;
    return low;
}

function splitOversizedSegment(segment, maximumBytes, maximumTokens) {
    const parts = [];
    let remaining = segment;
    while (Buffer.byteLength(remaining, 'utf8') > maximumBytes || tokenCount(remaining) > maximumTokens) {
        let end = prefixWithinLimits(remaining, maximumBytes, maximumTokens);
        if (end < 1) throw new Error('Unable to split an oversized Markdown segment.');
        const searchStart = Math.max(0, Math.floor(end * 0.75));
        const candidate = remaining.slice(searchStart, end);
        const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
        if (boundary > 0) end = searchStart + boundary;
        parts.push(remaining.slice(0, end).trim());
        remaining = remaining.slice(end).trim();
    }
    if (remaining) parts.push(remaining);
    return parts;
}

function splitBook(book) {
    if (book.bytes <= maximumUnitBytes && book.tokenCount <= maximumUnitTokens) {
        const content = applyPartContext(book.content, 1, 1);
        const tokens = countTokens(content);
        return [{
            ...book,
            content,
            bytes: Buffer.byteLength(content, 'utf8'),
            tokenCount: tokens.tokens,
            tokenCounts: tokens.byEncoding,
            unitIndex: 1,
            unitCount: 1,
            unitTitle: book.title
        }];
    }
    const separator = '\n\n';
    const separatorBytes = Buffer.byteLength(separator, 'utf8');
    const separatorTokens = tokenCount(separator);
    const paragraphs = [];
    for (const paragraph of book.content.split(/\n{2,}/)) {
        const bytes = Buffer.byteLength(paragraph, 'utf8');
        const tokens = countTokens(paragraph);
        const parts = bytes > maximumUnitBytes || tokens.tokens > maximumUnitTokens
            ? splitOversizedSegment(paragraph, maximumUnitBytes, maximumUnitTokens)
            : [paragraph];
        for (const content of parts) {
            const partBytes = Buffer.byteLength(content, 'utf8');
            const partTokens = parts.length === 1 ? tokens : countTokens(content);
            paragraphs.push({ content, bytes: partBytes, tokens: partTokens });
        }
    }

    // Encoding the ever-growing candidate after every paragraph made this
    // quadratic for large collected works. Per-paragraph token counts form a
    // conservative packing budget; each completed chunk is still encoded in
    // full below, so the real upload limits remain authoritative.
    const chunks = [];
    let currentParts = [];
    let currentBytes = 0;
    let currentTokenBudget = 0;
    const flush = () => {
        if (!currentParts.length) return;
        const content = currentParts.map(part => part.content).join(separator);
        const tokens = countTokens(content);
        if (Buffer.byteLength(content, 'utf8') > maximumUnitBytes || tokens.tokens > maximumUnitTokens) {
            for (const split of splitOversizedSegment(content, maximumUnitBytes, maximumUnitTokens)) {
                chunks.push({ content: split, tokens: countTokens(split) });
            }
        } else {
            chunks.push({ content, tokens });
        }
        currentParts = [];
        currentBytes = 0;
        currentTokenBudget = 0;
    };
    for (const paragraph of paragraphs) {
        const addedBytes = (currentParts.length ? separatorBytes : 0) + paragraph.bytes;
        const addedTokenBudget = (currentParts.length ? separatorTokens : 0) + paragraph.tokens.tokens;
        if (currentParts.length && (
            currentBytes + addedBytes > maximumUnitBytes ||
            currentTokenBudget + addedTokenBudget > maximumUnitTokens
        )) flush();
        currentParts.push(paragraph);
        currentBytes += (currentParts.length > 1 ? separatorBytes : 0) + paragraph.bytes;
        currentTokenBudget += (currentParts.length > 1 ? separatorTokens : 0) + paragraph.tokens.tokens;
    }
    flush();

    return chunks.map(({ content }, index) => {
        const contextualizedContent = applyPartContext(content, index + 1, chunks.length);
        const tokens = countTokens(contextualizedContent);
        return {
            ...book,
            content: contextualizedContent,
            bytes: Buffer.byteLength(contextualizedContent, 'utf8'),
            words: countWords(contextualizedContent),
            tokenCount: tokens.tokens,
            tokenCounts: tokens.byEncoding,
            unitIndex: index + 1,
            unitCount: chunks.length,
            unitTitle: `${book.title} (část ${index + 1}/${chunks.length})`
        };
    });
}

function packUnits(units) {
    const buckets = [];
    const sorted = [...units].sort((a, b) => (
        Math.max(b.bytes / usableFileBytes, b.tokenCount / usableFileTokens) -
        Math.max(a.bytes / usableFileBytes, a.tokenCount / usableFileTokens)
    ) || b.selectionScore - a.selectionScore || a.title.localeCompare(b.title));
    for (const unit of sorted) {
        let bestBucket = null;
        let smallestRemainder = Number.POSITIVE_INFINITY;
        for (const bucket of buckets) {
            const byteRemainder = usableFileBytes - bucket.bytes - unit.bytes;
            const tokenRemainder = usableFileTokens - bucket.tokenCount - unit.tokenCount;
            const remainder = Math.max(byteRemainder / usableFileBytes, tokenRemainder / usableFileTokens);
            if (byteRemainder >= 0 && tokenRemainder >= 0 && remainder < smallestRemainder) {
                bestBucket = bucket;
                smallestRemainder = remainder;
            }
        }
        if (!bestBucket) {
            bestBucket = { units: [], bytes: 0, tokenCount: 0 };
            buckets.push(bestBucket);
        }
        bestBucket.units.push(unit);
        bestBucket.bytes += unit.bytes;
        bestBucket.tokenCount += unit.tokenCount;
    }
    return buckets;
}

function fitSelectionToFileCount(selection) {
    const selected = [...selection.selected];
    const excluded = [...selection.excluded];
    const splitProgress = new ProgressTracker({ scope: `merge:${corpusName}:split`, total: selected.length });
    let units = [];
    for (const [index, book] of selected.entries()) {
        const progressId = `merge-split-${index}`;
        splitProgress.start(progressId, index + 1, book.title);
        const bookUnits = splitBook(book);
        units.push(...bookUnits);
        splitProgress.complete(progressId, `${bookUnits.length} part${bookUnits.length === 1 ? '' : 's'}`);
    }
    splitProgress.dispose();
    while (true) {
        const buckets = packUnits(units);
        if (buckets.length <= maxBookFiles) return { selected, excluded, units, buckets };
        const removed = [...selected].sort((a, b) => (
            a.selectionScore - b.selectionScore ||
            a.comparativePriority - b.comparativePriority ||
            b.tokenCount - a.tokenCount
        ))[0];
        selected.splice(selected.indexOf(removed), 1);
        units = units.filter(unit => unit.id !== removed.id);
        excluded.push({ ...removed, exclusionReason: 'bin_packing_capacity' });
    }
}

function unitAnchor(unit) {
    return `${slugify(unit.id || unit.title)}-${unit.unitIndex}`;
}

function renderMergedBody(fileName, bucket) {
    const orderedUnits = [...bucket.units].sort((a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title) || a.unitIndex - b.unitIndex);
    const toc = orderedUnits.map(unit => `- [${unit.author ? `${unit.author} — ` : ''}${unit.unitTitle}](#${unitAnchor(unit)})`).join('\n');
    const body = orderedUnits.map(unit => {
        const anchor = unitAnchor(unit);
        const sections = extractRetrievalSections(unit.content);
        const sectionToc = sections.length
            ? sections.map(section => `- [${section.type}: ${section.title}](#${section.anchor})`).join('\n')
            : '- V této části nebyly bezpečně rozpoznány samostatné vnitřní oddíly.';
        return [
            `<a id="${anchor}"></a>`,
            '',
            `## BOOK: ${unit.author ? `${unit.author} — ` : ''}${unit.unitTitle}`,
            '',
            '<!-- CORPUS_METADATA_BEGIN -->',
            `BOOK_ID: ${anchor}`,
            `WORK_ID: ${unit.id}`,
            `AUTHOR: ${unit.author}`,
            `TITLE: ${unit.title}`,
            `BOOK_PART: ${unit.unitIndex}/${unit.unitCount}`,
            `SOURCE_FILE: ${unit.fileName}`,
            '<!-- CORPUS_METADATA_END -->',
            '',
            `[CORPUS_CONTEXT: BOOK_ID=${anchor} | AUTHOR=${unit.author} | TITLE=${unit.title} | PART=${unit.unitIndex}/${unit.unitCount}]`,
            '',
            '### BOOK CONTENTS',
            '',
            sectionToc,
            '',
            unit.content
        ].join('\n');
    }).join('\n\n');
    return [`# CORPUS FILE: ${fileName}`, '', '## FILE CONTENTS', '', toc, '', body, ''].join('\n');
}

function buildLocations(bucketRecords) {
    const locations = new Map();
    for (const record of bucketRecords) {
        for (const unit of record.bucket.units) {
            const values = locations.get(unit.id) || [];
            values.push({ fileName: record.fileName, anchor: unitAnchor(unit) });
            locations.set(unit.id, values);
        }
    }
    return locations;
}

function renderEmbeddedIndex(bucketRecords, selectedBooks) {
    const locations = buildLocations(bucketRecords);
    const lines = [
        `# Rozcestník — ${corpusName}`,
        '',
        `Korpus obsahuje ${selectedBooks.length} děl v ${bucketRecords.length} souborech 01–${String(bucketRecords.length).padStart(2, '0')}.`,
        'Níže uvedené odkazy vedou na všechny zabalené části korpusu.',
        ''
    ];
    for (const book of [...selectedBooks].sort((a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title))) {
        lines.push(`## ${book.author ? `${book.author} — ` : ''}${book.title}`, '');
        if (book.summaryCz) lines.push(book.summaryCz, '');
        const links = locations.get(book.id) || [];
        lines.push(`Soubory: ${links.map((link, index) => `[${index + 1}](./${link.fileName}#${link.anchor})`).join(', ')}`, '');
    }
    return `${lines.join('\n')}\n`;
}

function validateEmbeddedIndexTargets(indexContent, bucketRecords) {
    const expectedTargets = [];
    for (const record of bucketRecords) {
        for (const unit of record.bucket.units) expectedTargets.push(`${record.fileName}#${unitAnchor(unit)}`);
    }
    const actualTargets = [...String(indexContent).matchAll(/\]\(\.\/([^#)]+\.md)#([^)]+)\)/g)]
        .map(match => `${match[1]}#${match[2]}`);
    const expectedCounts = new Map();
    const actualCounts = new Map();
    for (const target of expectedTargets) expectedCounts.set(target, (expectedCounts.get(target) || 0) + 1);
    for (const target of actualTargets) actualCounts.set(target, (actualCounts.get(target) || 0) + 1);
    const missing = [...expectedCounts].filter(([target, count]) => (actualCounts.get(target) || 0) !== count);
    const unexpected = [...actualCounts].filter(([target, count]) => (expectedCounts.get(target) || 0) !== count);
    if (missing.length || unexpected.length) {
        throw new Error(`Embedded index targets do not match final filenames/anchors; missing=${missing.map(([target]) => target).join(', ') || 'none'}; unexpected=${unexpected.map(([target]) => target).join(', ') || 'none'}`);
    }
    const expectedFiles = new Set(bucketRecords.map(record => record.fileName));
    const linkedFiles = new Set(actualTargets.map(target => target.split('#')[0]));
    const unlinkedFiles = [...expectedFiles].filter(fileName => !linkedFiles.has(fileName));
    if (unlinkedFiles.length) throw new Error(`Embedded index does not reference final files: ${unlinkedFiles.join(', ')}`);
    return { valid: true, targetCount: actualTargets.length, linkedFileCount: linkedFiles.size };
}

function summarizeSelection(selected) {
    const authors = new Map();
    const topics = new Map();
    for (const book of selected) {
        authors.set(book.author, (authors.get(book.author) || 0) + 1);
        for (const topic of book.topicKeys || []) topics.set(topic, (topics.get(topic) || 0) + 1);
    }
    return {
        byAuthor: Object.fromEntries([...authors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        byTopic: Object.fromEntries([...topics.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    };
}

function main() {
    progressLog(`merge:${corpusName}`, `starting; max files=${maxBookFiles}; max file size=${(maxFileSizeBytes / 1024 / 1024).toFixed(2)} MiB; max tokens=${maxTokensPerFile}`);
    prepareOutputFolder();
    const loaded = loadBooks();
    progressLog(`merge:${corpusName}`, 'evaluating Markdown quality and selecting the marginal-value portfolio');
    const hardQualityExcluded = loaded.books
        .filter(book => book.quality.hardReasons.length > 0)
        .map(book => ({ ...book, exclusionReason: `quality:${book.quality.hardReasons.join(',')}` }));
    const eligible = loaded.books.filter(book => book.quality.hardReasons.length === 0);
    const limits = {
        byteCapacity: maxBookFiles * usableFileBytes,
        tokenCapacity: maxBookFiles * usableFileTokens
    };
    const selection = selectPortfolio(eligible, loaded.atlas, limits);
    selection.excluded.push(...hardQualityExcluded);
    selection.excluded.push(...loaded.deferred);
    const fitted = fitSelectionToFileCount(selection);
    if (!fitted.buckets.length) throw new Error('Portfolio selection produced no output files.');
    progressLog(
        `merge:${corpusName}`,
        `portfolio fitted: ${fitted.selected.length}/${loaded.conversionCandidateCount} conversion candidates (${loaded.inputBookCount} eligible works) in ${fitted.buckets.length} files`
    );
    const buckets = fitted.buckets.sort((a, b) => {
        const aTitle = [...a.units].sort((x, y) => x.title.localeCompare(y.title))[0]?.title || '';
        const bTitle = [...b.units].sort((x, y) => x.title.localeCompare(y.title))[0]?.title || '';
        return aTitle.localeCompare(bTitle);
    });
    const bucketRecords = buckets.map((bucket, index) => ({
        bucket,
        fileName: buildMergedFileName(bucket, index)
    }));
    const indexContent = renderEmbeddedIndex(bucketRecords, fitted.selected);
    const embeddedIndexValidation = validateEmbeddedIndexTargets(indexContent, bucketRecords);
    const reportEntries = [];
    const writeProgress = new ProgressTracker({ scope: `merge:${corpusName}:write`, total: bucketRecords.length });
    for (const [index, record] of bucketRecords.entries()) {
        const progressId = `merge-output-${index}`;
        writeProgress.start(progressId, index + 1, record.fileName);
        const body = renderMergedBody(record.fileName, record.bucket);
        const content = index === 0 ? `${indexContent}\n---\n\n${body}` : body;
        const retrievalValidation = validateMergedRetrievalMarkdown(body);
        if (!retrievalValidation.valid) {
            throw new Error(`${record.fileName} retrieval validation failed: ${retrievalValidation.errors.join(' | ')}`);
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        const tokens = countTokens(content);
        if (bytes > maxFileSizeBytes) throw new Error(`${record.fileName} is ${bytes} bytes, over hard limit ${maxFileSizeBytes}.`);
        if (tokens.tokens > maxTokensPerFile) throw new Error(`${record.fileName} is ${tokens.tokens} tokens, over hard limit ${maxTokensPerFile}.`);
        const destination = path.join(outputFolder, record.fileName);
        const temporary = `${destination}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, content, 'utf8');
        fs.renameSync(temporary, destination);
        reportEntries.push({
            fileName: record.fileName,
            bytes,
            bookCount: new Set(record.bucket.units.map(unit => unit.id)).size,
            unitCount: record.bucket.units.length,
            words: record.bucket.units.reduce((sum, unit) => sum + unit.words, 0),
            tokenCount: tokens.tokens,
            tokenCounts: tokens.byEncoding,
            containsEmbeddedIndex: index === 0,
            retrievalValidation,
            units: record.bucket.units.map(unit => ({
                bookId: unit.id,
                title: unit.title,
                part: unit.unitIndex,
                parts: unit.unitCount,
                anchor: unitAnchor(unit),
                bytes: unit.bytes,
                tokenCount: unit.tokenCount
            }))
        });
        writeProgress.complete(progressId, `${(bytes / 1024 / 1024).toFixed(2)} MiB; ${tokens.tokens} tokens`);
        console.log(`Created ${record.fileName}: ${(bytes / 1024 / 1024).toFixed(2)} MiB, ${tokens.tokens} tokens, ${record.bucket.units.length} units.`);
    }
    writeProgress.dispose();

    const excluded = fitted.excluded.map(book => ({
        id: book.id,
        author: book.author,
        title: book.title,
        contentType: book.contentType,
        portfolioRole: book.portfolioRole,
        comparativePriority: book.comparativePriority,
        priorityScore: book.priorityScore,
        relevanceScore: book.relevanceScore,
        selectionScore: book.selectionScore,
        selectionComponents: book.selectionComponents,
        bytes: book.bytes,
        tokenCount: book.tokenCount,
        fileName: book.fileName,
        qualityWarnings: book.quality?.warnings || [],
        reason: book.exclusionReason
    }));
    const quality = loaded.books.map(book => ({
        id: book.id,
        author: book.author,
        title: book.title,
        selected: fitted.selected.some(selected => selected.id === book.id),
        original: book.originalQuality,
        final: book.quality,
        postprocessing: book.postprocessing
    })).filter(entry => entry.original.warnings.length || entry.postprocessing.removedCorruptedLines > 0 || entry.original.hardReasons.length);
    const largestFileBytes = Math.max(...reportEntries.map(entry => entry.bytes));
    const largestTokenCount = Math.max(...reportEntries.map(entry => entry.tokenCount));
    const report = {
        generatedAt: new Date().toISOString(),
        corpus: corpusName,
        curationAtlasHash: loaded.manifest.curationAtlasHash,
        limits: {
            maxBookFiles,
            reservedExternalKnowledgeFiles: 2,
            finalKnowledgeFileTotalAtFullUse: maxBookFiles + 2,
            indexMode,
            maxFileSizeBytes,
            preferredFileSizeBytes,
            usableFileBytes,
            maxTokensPerFile,
            usableFileTokens,
            tokenEncodings: Object.keys(reportEntries[0].tokenCounts)
        },
        validation: {
            finalBookFileCount: reportEntries.length,
            largestFileBytes,
            largestTokenCount,
            fileCountWithinLimit: reportEntries.length <= maxBookFiles,
            fileSizeWithinLimit: largestFileBytes <= maxFileSizeBytes,
            tokenCountWithinLimit: largestTokenCount <= maxTokensPerFile,
            embeddedIndexTargetsValid: embeddedIndexValidation.valid
        },
        inputBookCount: loaded.inputBookCount,
        conversionCandidateCount: loaded.conversionCandidateCount,
        eligibleBookCount: eligible.length,
        selectedBookCount: fitted.selected.length,
        excludedBookCount: excluded.length,
        selectedInputBytes: fitted.selected.reduce((sum, book) => sum + book.bytes, 0),
        selectedInputTokens: fitted.selected.reduce((sum, book) => sum + book.tokenCount, 0),
        finalBytes: reportEntries.reduce((sum, entry) => sum + entry.bytes, 0),
        finalTokens: reportEntries.reduce((sum, entry) => sum + entry.tokenCount, 0),
        selectionSummary: summarizeSelection(fitted.selected),
        selected: fitted.selected.map(book => ({
            id: book.id,
            author: book.author,
            title: book.title,
            portfolioRole: book.portfolioRole,
            comparativePriority: book.comparativePriority,
            selectionScore: book.selectionScore,
            selectionComponents: book.selectionComponents,
            authorRank: book.authorRank,
            creatorWorkCount: book.creatorWorkCount,
            topicKeys: book.topicKeys,
            mustInclude: book.mustInclude,
            qualityWarnings: book.quality.warnings,
            postprocessing: book.postprocessing,
            bytes: book.bytes,
            tokenCount: book.tokenCount
        })),
        files: reportEntries,
        excluded,
        quality
    };
    writeJsonAtomic(mergeReportFile, report);
    if (!Object.values(report.validation).filter(value => typeof value === 'boolean').every(Boolean)) {
        throw new Error('Hard upload-limit validation failed.');
    }
    const currentFiles = new Set(reportEntries.map(entry => entry.fileName));
    for (const entry of fs.readdirSync(outputFolder, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && !currentFiles.has(entry.name)) {
            fs.rmSync(path.join(outputFolder, entry.name), { force: true });
        }
    }
    console.log(`Selected ${report.selectedBookCount}/${report.inputBookCount} eligible books from ${report.conversionCandidateCount} converted candidates; excluded ${report.excludedBookCount}.`);
    console.log(`Validated ${reportEntries.length}/${maxBookFiles} book files; largest ${(largestFileBytes / 1024 / 1024).toFixed(2)} MiB / ${largestTokenCount} tokens.`);
    progressLog(`merge:${corpusName}`, `complete: ${reportEntries.length} files, ${report.selectedBookCount} selected books`);
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

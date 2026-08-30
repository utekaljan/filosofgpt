'use strict';

const fs = require('fs');
const path = require('path');
const {
    compareSourceVariants,
    config,
    ensureDirectory,
    mapLimit,
    normalizeWhitespace,
    parseNameHints,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath,
    sha256File,
    shortStableId,
    workHintKey,
    writeJsonAtomic,
    writeJsonLinesAtomic
} = require('../../lib/corpus-pipeline');
const { progressLog, ProgressTracker } = require('../../lib/progress');

const sourceDir = resolveProjectPath(config.sourceDir);
const stateDir = resolveProjectPath(config.stateDir);
const inventoryPath = path.join(stateDir, 'inventory.json');
const candidatesPath = path.join(stateDir, 'candidates.json');
const force = process.argv.includes('--force');
const inventoryVersion = 2;
const concurrencyArgument = process.argv.find(argument => argument.startsWith('--concurrency='));
const concurrency = Math.max(1, Number.parseInt(concurrencyArgument?.split('=')[1], 10) || 4);

async function listSupportedFiles(directoryPath) {
    const results = [];
    const directory = await fs.promises.opendir(directoryPath);
    for await (const entry of directory) {
        if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')) {
            continue;
        }
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            results.push(...await listSupportedFiles(absolutePath));
            continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        if (entry.isFile() && config.supportedExtensions.includes(extension)) {
            results.push(absolutePath);
        }
    }
    return results;
}

async function extractMarkdownMetadata(filePath) {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(128 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const sample = buffer.subarray(0, bytesRead).toString('utf8');
        const title = sample.match(/^#\s+(.+)$/m)?.[1] || '';
        const author = sample.match(/^##?\s+(?:Author|Autor):\s*(.+)$/im)?.[1] || '';
        return {
            title: normalizeWhitespace(title),
            author: normalizeWhitespace(author),
            textSample: normalizeWhitespace(sample.replace(/[#*_>`\[\]()]/g, ' ')).slice(0, 1200)
        };
    } finally {
        await handle.close();
    }
}

async function inspectFile(filePath, previousByPath) {
    const relativePath = path.relative(sourceDir, filePath);
    const stat = await fs.promises.stat(filePath);
    const previous = previousByPath.get(relativePath);
    if (!force && previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
        const hints = parseNameHints(relativePath, previous.metadata || {});
        return {
            ...previous,
            inventoryVersion,
            hints,
            workHintKey: workHintKey(hints)
        };
    }

    const extension = path.extname(filePath).toLowerCase();
    const [sha256, metadata] = await Promise.all([
        sha256File(filePath),
        extractMarkdownMetadata(filePath)
    ]);
    const hints = parseNameHints(relativePath, metadata);
    return {
        inventoryVersion,
        id: shortStableId('file', relativePath),
        relativePath,
        extension,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
        metadata,
        hints,
        workHintKey: workHintKey(hints)
    };
}

class DisjointSet {
    constructor(size) {
        this.parent = Array.from({ length: size }, (_, index) => index);
    }

    find(index) {
        if (this.parent[index] !== index) {
            this.parent[index] = this.find(this.parent[index]);
        }
        return this.parent[index];
    }

    union(left, right) {
        const leftRoot = this.find(left);
        const rightRoot = this.find(right);
        if (leftRoot !== rightRoot) {
            this.parent[rightRoot] = leftRoot;
        }
    }
}

function buildCandidates(files, previousCandidates = []) {
    const sets = new DisjointSet(files.length);
    const byHash = new Map();
    const byHint = new Map();

    files.forEach((file, index) => {
        const hashIndex = byHash.get(file.sha256);
        if (hashIndex !== undefined) {
            sets.union(index, hashIndex);
        } else {
            byHash.set(file.sha256, index);
        }

        if (file.workHintKey) {
            const hintIndex = byHint.get(file.workHintKey);
            if (hintIndex !== undefined) {
                sets.union(index, hintIndex);
            } else {
                byHint.set(file.workHintKey, index);
            }
        }
    });

    const groups = new Map();
    files.forEach((file, index) => {
        const root = sets.find(index);
        const group = groups.get(root) || [];
        group.push(file);
        groups.set(root, group);
    });

    const previousByFileId = new Map();
    for (const candidate of previousCandidates) {
        for (const variant of candidate.variants || []) {
            const candidates = previousByFileId.get(variant.fileId) || [];
            candidates.push(candidate);
            previousByFileId.set(variant.fileId, candidates);
        }
    }
    const usedPreviousIds = new Set();

    return [...groups.values()]
        .map(variants => {
            variants.sort(compareSourceVariants);
            const primary = variants[0];
            const overlapCounts = new Map();
            for (const variant of variants) {
                for (const previous of previousByFileId.get(variant.id) || []) {
                    overlapCounts.set(previous.id, (overlapCounts.get(previous.id) || 0) + 1);
                }
            }
            const reusableId = [...overlapCounts.entries()]
                .filter(([id]) => !usedPreviousIds.has(id))
                .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
            if (reusableId) usedPreviousIds.add(reusableId);
            return {
                id: reusableId || shortStableId('work', variants.map(file => file.id).sort().join('|')),
                hint: primary.hints,
                primaryFileId: primary.id,
                variants: variants.map(file => ({
                    fileId: file.id,
                    relativePath: file.relativePath,
                    extension: file.extension,
                    size: file.size,
                    sha256: file.sha256,
                    metadata: file.metadata,
                    exactDuplicateOfPrimary: file !== primary && file.sha256 === primary.sha256
                }))
            };
        })
        .sort((a, b) => {
            const authorDifference = a.hint.author.localeCompare(b.hint.author);
            return authorDifference || a.hint.title.localeCompare(b.hint.title) || a.id.localeCompare(b.id);
        });
}

async function main() {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source directory does not exist: ${sourceDir}`);
    }
    ensureDirectory(stateDir);
    const previousInventory = readJsonIfExists(inventoryPath, { files: [] });
    const previousCandidateDocument = readJsonIfExists(candidatesPath, { candidates: [] });
    const previousByPath = new Map((previousInventory.files || []).map(file => [file.relativePath, file]));
    progressLog('inventory', `scanning ${path.relative(projectRoot, sourceDir)} recursively`);
    const filePaths = (await listSupportedFiles(sourceDir)).sort((a, b) => a.localeCompare(b));

    progressLog('inventory', `found ${filePaths.length} supported files; concurrency=${concurrency}`);
    const progress = new ProgressTracker({ scope: 'inventory', total: filePaths.length });
    const files = await mapLimit(filePaths, concurrency, async filePath => {
        const result = await inspectFile(filePath, previousByPath);
        progress.advance(path.relative(sourceDir, filePath));
        return result;
    });
    progress.dispose();
    progressLog('inventory', 'building conservative duplicate groups and candidate works');
    const candidates = buildCandidates(files, previousCandidateDocument.candidates || []);
    const exactDuplicateCount = files.length - new Set(files.map(file => file.sha256)).size;
    const summary = {
        generatedAt: new Date().toISOString(),
        sourceDir,
        fileCount: files.length,
        candidateWorkCount: candidates.length,
        exactDuplicateCount,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        byExtension: Object.fromEntries(config.supportedExtensions.map(extension => [
            extension,
            files.filter(file => file.extension === extension).length
        ]))
    };

    writeJsonAtomic(inventoryPath, { summary, files });
    writeJsonLinesAtomic(path.join(stateDir, 'inventory.jsonl'), files);
    writeJsonAtomic(candidatesPath, { summary, candidates });
    writeJsonLinesAtomic(path.join(stateDir, 'candidates.jsonl'), candidates);
    progressLog('inventory', `complete: ${files.length} files, ${candidates.length} candidate works`);
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Inventory: ${path.relative(projectRoot, inventoryPath)}`);
    console.log(`Candidates: ${path.relative(projectRoot, candidatesPath)}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    buildCandidates,
    inspectFile,
    listSupportedFiles
};

'use strict';

const fs = require('fs');
const path = require('path');
const {
    config,
    ensureDirectory,
    normalizeWhitespace,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath
} = require('../../lib/corpus-pipeline');
const { progressLog } = require('../../lib/progress');

const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.slice('--corpus='.length);
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;
const reportsDir = resolveProjectPath(config.reportsDir);
const outputDir = path.join(reportsDir, 'book-lists');

function compareCzech(left, right) {
    return String(left || '').localeCompare(String(right || ''), 'cs', {
        sensitivity: 'base',
        numeric: true
    });
}

function sortedEntries(entries) {
    return [...entries].sort((left, right) => (
        compareCzech(left.author, right.author) ||
        compareCzech(left.title, right.title) ||
        compareCzech(left.id, right.id)
    ));
}

function renderBookList(corpus, label, entries, { includeReason = false } = {}) {
    const normalized = sortedEntries(entries).map(entry => ({
        ...entry,
        author: normalizeWhitespace(entry.author) || 'Neznámý autor',
        title: normalizeWhitespace(entry.title) || 'Bez názvu'
    }));
    const lines = [
        `${corpus} — ${label}`,
        `Počet knih: ${normalized.length}`,
        'Řazení: autor, potom název',
        ''
    ];
    let previousAuthor = null;
    for (const entry of normalized) {
        if (entry.author !== previousAuthor) {
            if (previousAuthor !== null) lines.push('');
            lines.push(entry.author);
            previousAuthor = entry.author;
        }
        const reason = includeReason && entry.reason ? ` [${entry.reason}]` : '';
        lines.push(`  - ${entry.title}${reason}`);
    }
    return `${lines.join('\n')}\n`;
}

function writeTextAtomic(filePath, content) {
    ensureDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function generateCorpusLists(corpus) {
    if (!config.corpora.includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
    const reportPath = path.join(reportsDir, 'merge', `${corpus}.json`);
    const report = readJsonIfExists(reportPath);
    if (!report) throw new Error(`Missing merge report: ${path.relative(projectRoot, reportPath)}`);
    if (!Array.isArray(report.selected) || !Array.isArray(report.excluded)) {
        throw new Error(`Merge report has no selected/excluded lists: ${path.relative(projectRoot, reportPath)}`);
    }

    const selectedPath = path.join(outputDir, `${corpus}-vybrane-knihy.txt`);
    const excludedPath = path.join(outputDir, `${corpus}-vyrazene-knihy.txt`);
    writeTextAtomic(selectedPath, renderBookList(corpus, 'VYBRANÉ KNIHY', report.selected));
    writeTextAtomic(excludedPath, renderBookList(corpus, 'VYŘAZENÉ KNIHY', report.excluded, { includeReason: true }));
    console.log(`Book lists: ${path.relative(projectRoot, selectedPath)}`);
    console.log(`Book lists: ${path.relative(projectRoot, excludedPath)}`);
    progressLog(`book-lists:${corpus}`, `complete: ${report.selected.length} selected, ${report.excluded.length} excluded`);
}

function main() {
    for (const corpus of corpora) generateCorpusLists(corpus);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    renderBookList,
    sortedEntries
};

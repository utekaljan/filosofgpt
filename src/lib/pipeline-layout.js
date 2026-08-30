'use strict';

const fs = require('fs');
const path = require('path');
const { projectRoot } = require('./corpus-pipeline');

const stageScripts = Object.freeze({
    'inventory-books.js': 'src/pipeline/catalog/inventory-books.js',
    'classify-books.js': 'src/pipeline/catalog/classify-books.js',
    'curate-corpora.js': 'src/pipeline/prioritization/curate-corpora.js',
    'organize-books.js': 'src/pipeline/prioritization/organize-books.js',
    'convert-corpora.js': 'src/pipeline/conversion/convert-corpora.js',
    'convert-books.js': 'src/pipeline/conversion/convert-books.js',
    'merge-corpora.js': 'src/pipeline/packaging/merge-corpora.js',
    'merge-md.js': 'src/pipeline/packaging/merge-md.js',
    'generate-book-lists.js': 'src/pipeline/packaging/generate-book-lists.js',
    'audit-pipeline.js': 'src/pipeline/validation/audit-pipeline.js',
    'generate-decisions-report.js': 'src/pipeline/validation/generate-decisions-report.js'
});

function resolveStageScript(scriptName) {
    const relativePath = stageScripts[scriptName];
    if (!relativePath) {
        throw new Error(`Unknown pipeline stage: ${scriptName}`);
    }
    const absolutePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing pipeline stage: ${relativePath}`);
    }
    return absolutePath;
}

module.exports = {
    resolveStageScript,
    stageScripts
};

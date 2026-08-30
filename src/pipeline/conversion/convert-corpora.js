'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    config,
    ensureDirectory,
    projectRoot,
    resolveProjectPath
} = require('../../lib/corpus-pipeline');
const { resolveStageScript } = require('../../lib/pipeline-layout');
const { formatDuration, progressLog } = require('../../lib/progress');

const clean = process.argv.includes('--clean');
const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.split('=')[1];
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;
const booksDir = resolveProjectPath(config.booksDir);
const markdownDir = resolveProjectPath(config.markdownDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const tempDir = path.join(resolveProjectPath(config.outputDir), 'temp');

function runCorpus(corpus) {
    if (!config.corpora.includes(corpus)) {
        throw new Error(`Unknown corpus: ${corpus}`);
    }
    const inputDir = path.join(booksDir, corpus);
    const outputDir = path.join(markdownDir, corpus);
    if (!fs.existsSync(path.join(inputDir, 'manifest.json'))) {
        throw new Error(`Missing organized-book manifest for ${corpus}; run node src/pipeline/prioritization/organize-books.js first.`);
    }
    ensureDirectory(outputDir);
    ensureDirectory(path.join(reportsDir, 'conversion'));
    ensureDirectory(path.join(tempDir, 'conversion', corpus));

    console.log(`\n=== Converting ${corpus} ===`);
    const startedAt = Date.now();
    progressLog(`convert:${corpus}`, `starting child converter; resume=${!clean}; input=${path.relative(projectRoot, inputDir)}`);
    const result = spawnSync(process.execPath, [resolveStageScript('convert-books.js')], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            BOOKS_INPUT_DIR: inputDir,
            MARKDOWN_OUTPUT_DIR: outputDir,
            CONVERSION_TEMP_DIR: path.join(tempDir, 'conversion', corpus),
            CONVERSION_ERROR_LOG: path.join(reportsDir, 'conversion', `${corpus}-errors.log`),
            CONVERSION_REPORT: path.join(reportsDir, 'conversion', `${corpus}.json`),
            CONVERSION_CLEAN: clean ? '1' : '0',
            CONVERSION_RESUME: clean ? '0' : '1'
        }
    });
    if (result.error) {
        throw result.error;
    }
    progressLog(`convert:${corpus}`, `child converter exited ${result.status ?? 1}; elapsed ${formatDuration(Date.now() - startedAt)}`);
    return result.status ?? 1;
}

let failed = false;
for (const corpus of corpora) {
    try {
        const status = runCorpus(corpus);
        if (status !== 0) {
            failed = true;
            console.error(`${corpus} conversion failed (exit ${status}).`);
        }
    } catch (error) {
        failed = true;
        console.error(error.stack || error.message);
    }
}

if (failed) {
    process.exitCode = 1;
} else {
    console.log('\nAll requested corpora converted successfully.');
}

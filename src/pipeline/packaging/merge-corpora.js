'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { config, ensureDirectory, projectRoot, resolveProjectPath } = require('../../lib/corpus-pipeline');
const { resolveStageScript } = require('../../lib/pipeline-layout');
const { formatDuration, progressLog } = require('../../lib/progress');

const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.split('=')[1];
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;
const booksDir = resolveProjectPath(config.booksDir);
const markdownDir = resolveProjectPath(config.markdownDir);
const mergedDir = resolveProjectPath(config.mergedDir);
const reportsDir = resolveProjectPath(config.reportsDir);

function runCorpus(corpus) {
    if (!config.corpora.includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
    const manifestPath = path.join(booksDir, corpus, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`Missing manifest: ${manifestPath}`);
    ensureDirectory(path.join(mergedDir, corpus));
    ensureDirectory(path.join(reportsDir, 'merge'));
    console.log(`\n=== Merging ${corpus} ===`);
    const startedAt = Date.now();
    progressLog(`merge:${corpus}`, `starting child merger from ${path.relative(projectRoot, path.join(markdownDir, corpus))}`);
    const result = spawnSync(process.execPath, [resolveStageScript('merge-md.js')], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            CORPUS_NAME: corpus,
            MARKDOWN_INPUT_DIR: path.join(markdownDir, corpus),
            MERGED_OUTPUT_DIR: path.join(mergedDir, corpus),
            MERGE_REPORT: path.join(reportsDir, 'merge', `${corpus}.json`),
            BOOKS_MANIFEST: manifestPath,
            MAX_BOOK_FILES: String(config.upload.maxBookFiles),
            INDEX_MODE: config.upload.indexMode,
            MAX_FILE_SIZE_BYTES: String(config.upload.maxFileSizeBytes),
            PREFERRED_FILE_SIZE_BYTES: String(config.upload.preferredFileSizeBytes),
            MAX_TOKENS_PER_FILE: String(config.upload.maxTokensPerFile)
        }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${corpus} merge failed with exit ${result.status}.`);
    progressLog(`merge:${corpus}`, `child merger complete; elapsed ${formatDuration(Date.now() - startedAt)}`);
}

let failed = false;
for (const corpus of corpora) {
    try {
        runCorpus(corpus);
    } catch (error) {
        failed = true;
        console.error(error.stack || error.message);
    }
}
if (failed) process.exitCode = 1;
else console.log('\nAll requested corpora merged and validated.');

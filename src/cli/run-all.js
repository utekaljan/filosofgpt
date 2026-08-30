'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    config,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath,
    writeJsonAtomic
} = require('../lib/corpus-pipeline');
const { resolveStageScript } = require('../lib/pipeline-layout');
const { formatDuration, progressLog } = require('../lib/progress');

const cleanConversion = process.argv.includes('--clean-conversion');
const skipClassification = process.argv.includes('--skip-classification');
const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.slice('--corpus='.length);
const corpusArguments = requestedCorpus ? [`--corpus=${requestedCorpus}`] : [];
const masterStatePath = path.join(resolveProjectPath(config.stateDir), 'master', 'run.json');
const modelArgument = process.argv.find(argument => argument.startsWith('--model='));
const reasoningArgument = process.argv.find(argument => argument.startsWith('--reasoning-effort='));
const classificationArguments = modelArgument ? [modelArgument] : [];
const curationArguments = [modelArgument, reasoningArgument].filter(Boolean);
let masterRun = null;

function runPreflight() {
    const result = spawnSync(process.execPath, [path.join(projectRoot, 'src/cli/preflight.js')], {
        cwd: projectRoot,
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Preflight failed; existing output was left untouched.');
}

function cleanConversionWorkspace() {
    const temporaryRoot = path.join(resolveProjectPath(config.outputDir), 'temp');
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function beginMasterRun() {
    const previous = readJsonIfExists(masterStatePath);
    masterRun = {
        version: 1,
        runId: `${new Date().toISOString()}-${process.pid}`,
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        arguments: process.argv.slice(2),
        scope: requestedCorpus || 'all',
        resumedInterruptedRunId: previous?.status === 'running' ? previous.runId : null,
        currentStage: null,
        stages: []
    };
    writeJsonAtomic(masterStatePath, masterRun);
}

function persistMasterRun() {
    masterRun.updatedAt = new Date().toISOString();
    writeJsonAtomic(masterStatePath, masterRun);
}

function finishMasterRun(status, error = null) {
    if (!masterRun) return;
    masterRun.status = status;
    masterRun.currentStage = null;
    masterRun.finishedAt = new Date().toISOString();
    if (error) masterRun.error = error instanceof Error ? error.message : String(error);
    persistMasterRun();
}

function run(scriptName, argumentsList = [], options = {}) {
    console.log(`\n=== ${scriptName} ${argumentsList.join(' ')} ===`);
    const startedAt = Date.now();
    const stage = {
        script: scriptName,
        arguments: argumentsList,
        status: 'running',
        startedAt: new Date().toISOString()
    };
    masterRun.currentStage = { script: scriptName, arguments: argumentsList, startedAt: stage.startedAt };
    masterRun.stages.push(stage);
    persistMasterRun();
    progressLog('pipeline', `START ${scriptName} ${argumentsList.join(' ')}`.trim());
    const result = spawnSync(process.execPath, [resolveStageScript(scriptName), ...argumentsList], {
        cwd: projectRoot,
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    stage.exitCode = result.status ?? 1;
    stage.status = result.status === 0 ? 'completed' : (options.allowFailure ? 'failed-allowed' : 'failed');
    stage.finishedAt = new Date().toISOString();
    stage.elapsedMs = Date.now() - startedAt;
    masterRun.currentStage = null;
    persistMasterRun();
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`${scriptName} failed with exit ${result.status}.`);
    }
    progressLog('pipeline', `END ${scriptName}; exit=${result.status ?? 1}; elapsed ${formatDuration(Date.now() - startedAt)}`);
    return result.status ?? 1;
}

function main() {
    runPreflight();
    beginMasterRun();
    if (requestedCorpus && !config.corpora.includes(requestedCorpus)) {
        throw new Error(`Unknown corpus: ${requestedCorpus}`);
    }
    progressLog(
        'pipeline',
        `starting canonical public pipeline; scope=${requestedCorpus || 'all corpora'}; ` +
        `skip-classification=${skipClassification}; clean-conversion=${cleanConversion}`
    );

    run('inventory-books.js');
    if (!skipClassification) {
        run('classify-books.js', classificationArguments);
        run('classify-books.js', ['--review-low-confidence', '--batch-size=10', ...classificationArguments]);
    } else {
        const catalog = readJsonIfExists(path.join(resolveProjectPath(config.stateDir), 'catalog.json'));
        if (!catalog || catalog.summary?.unclassifiedCandidateCount > 0) {
            throw new Error('--skip-classification requires an already complete catalog.');
        }
    }
    run('curate-corpora.js', [...corpusArguments, ...curationArguments]);
    run('organize-books.js', corpusArguments);

    run('convert-corpora.js', [
        ...corpusArguments,
        ...(cleanConversion ? ['--clean'] : [])
    ]);

    cleanConversionWorkspace();
    run('merge-corpora.js', corpusArguments);
    run('audit-pipeline.js', corpusArguments);
    run('generate-book-lists.js', corpusArguments);
    run('generate-decisions-report.js', corpusArguments);
    finishMasterRun('completed');
    console.log('\nPipeline completed and passed the audit.');
}

try {
    main();
} catch (error) {
    finishMasterRun('failed', error);
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

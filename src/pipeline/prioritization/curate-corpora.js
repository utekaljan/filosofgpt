'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
    config,
    ensureDirectory,
    mapLimit,
    leadCreatorKey,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath,
    stableHash,
    writeJsonAtomic
} = require('../../lib/corpus-pipeline');
const { countTokens } = require('../../lib/token-counter');
const { progressLog, ProgressTracker } = require('../../lib/progress');
const {
    atlasAdditionCompatibility,
    buildAtlasBasis,
    buildAtlasPrompt,
    buildCurationBatches,
    buildCurationPrompt,
    buildPortfolio,
    curationContractVersion,
    curationInputHash,
    groupWorksByCreator,
    validateAtlas,
    validateCurationBatch
} = require('../../lib/portfolio-curation');

const stateDir = resolveProjectPath(config.stateDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const catalogPath = path.join(stateDir, 'catalog.json');
const curationDir = path.join(stateDir, 'curation');
const atlasSchemaPath = path.join(projectRoot, 'src', 'schemas', 'curation-atlas.schema.json');
const resultSchemaPath = path.join(projectRoot, 'src', 'schemas', 'curation-result.schema.json');
const lockPath = path.join(curationDir, 'curation.lock');

function numberArgument(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArgument(name, fallback = '') {
    const prefix = `--${name}=`;
    return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const requestedCorpus = stringArgument('corpus');
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;
const batchSize = numberArgument('batch-size', config.curation.batchSize);
const concurrency = numberArgument('concurrency', config.curation.concurrency);
const maximumAttempts = numberArgument('attempts', config.curation.maxAttempts);
const maximumBatches = numberArgument('max-batches', Number.MAX_SAFE_INTEGER);
const timeoutMilliseconds = numberArgument('timeout-minutes', config.curation.timeoutMinutes) * 60 * 1000;
const model = stringArgument('model');
const reasoningEffort = stringArgument('reasoning-effort', 'high');
const atlasOnly = process.argv.includes('--atlas-only');
const planOnly = process.argv.includes('--plan-only');
const rebuildPortfolioOnly = process.argv.includes('--rebuild-portfolio');
const atlasPromptPolicyVersion = 2;

function acquireLock() {
    ensureDirectory(curationDir);
    const create = () => {
        const descriptor = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
        fs.closeSync(descriptor);
    };
    try {
        create();
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existingPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        let active = false;
        try {
            if (Number.isFinite(existingPid)) process.kill(existingPid, 0);
            active = Number.isFinite(existingPid);
        } catch {
            active = false;
        }
        if (active) throw new Error(`Another curation process is active (PID ${existingPid}).`);
        fs.rmSync(lockPath, { force: true });
        create();
    }
    return () => {
        if (!fs.existsSync(lockPath)) return;
        const owner = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
        if (owner === process.pid) fs.rmSync(lockPath, { force: true });
    };
}

function corpusPaths(corpus) {
    const directory = path.join(curationDir, corpus);
    return {
        directory,
        atlasRecord: path.join(directory, 'atlas-record.json'),
        atlas: path.join(directory, 'atlas.json'),
        portfolio: path.join(directory, 'portfolio.json'),
        resultDir: path.join(directory, 'by-id'),
        temporaryDir: path.join(directory, 'tmp')
    };
}

function runCodexPrompt({ prompt, schemaPath, outputPath }) {
    return new Promise((resolve, reject) => {
        fs.rmSync(outputPath, { force: true });
        const args = [
            'exec',
            '--ephemeral',
            '--sandbox', 'read-only',
            '--skip-git-repo-check',
            '--ignore-rules',
            '--color', 'never',
            '-c', `model_reasoning_effort="${reasoningEffort}"`,
            '-C', os.tmpdir(),
            '--output-schema', schemaPath,
            '--output-last-message', outputPath
        ];
        if (model) args.push('--model', model);
        args.push('-');
        const child = spawn('codex', args, { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const diagnosticSummary = () => (
            'Codex diagnostic streams were omitted to prevent curation prompt disclosure ' +
            `(stdout=${stdoutBytes} bytes, stderr=${stderrBytes} bytes).`
        );
        child.stdout.on('data', chunk => { stdoutBytes += chunk.length; });
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Codex timed out after ${timeoutMilliseconds / 60000} minutes.`));
        }, timeoutMilliseconds);
        child.on('error', error => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(`Codex exited ${code}. ${diagnosticSummary()}`));
                return;
            }
            try {
                resolve(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
            } catch (error) {
                reject(new Error(`${error.message}\n${diagnosticSummary()}`));
            }
        });
        child.stdin.on('error', error => {
            if (error.code !== 'EPIPE') reject(error);
        });
        child.stdin.end(`${prompt}\n`);
    });
}

async function withRetries(label, operation) {
    let lastError;
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
        try {
            progressLog('curation', `${label}: attempt ${attempt}/${maximumAttempts}`);
            return await operation(attempt);
        } catch (error) {
            lastError = error;
            console.error(`${label}, attempt ${attempt}/${maximumAttempts}: ${error.message}`);
            if (error.nonRetryable === true) {
                progressLog('curation', `${label}: deterministic validation failure; refusing a blind full-prompt retry`);
                throw error;
            }
        }
    }
    throw lastError;
}

function atlasInputHash(corpus, works, prompt) {
    return stableHash({
        contractVersion: curationContractVersion,
        corpus,
        model: model || null,
        reasoningEffort,
        prompt
    });
}

async function loadOrCreateAtlas(corpus, works, paths) {
    const prompt = buildAtlasPrompt(corpus, works);
    const inputHash = atlasInputHash(corpus, works, prompt);
    const saved = readJsonIfExists(paths.atlasRecord);
    if (saved?.contractVersion === curationContractVersion && saved.inputHash === inputHash && saved.atlas) {
        progressLog(`curation:${corpus}`, 'reusing compatible cached global atlas');
        const cachedWarnings = [];
        const cachedAtlas = validateAtlas(saved.atlas, corpus, works, warning => cachedWarnings.push(warning));
        if (cachedWarnings.length > 0) {
            throw new Error(`${corpus}: compatible cached atlas unexpectedly required ${cachedWarnings.length} reference repairs.`);
        }
        if (!saved.basis) {
            writeJsonAtomic(paths.atlasRecord, {
                ...saved,
                basis: buildAtlasBasis(corpus, works),
                basisRecordedAt: new Date().toISOString()
            });
            progressLog(`curation:${corpus}`, 'recorded append-compatible atlas basis for future incremental books');
        }
        return cachedAtlas;
    }
    if (saved?.contractVersion === curationContractVersion && saved.atlas && saved.basis) {
        const addition = atlasAdditionCompatibility(saved.basis, corpus, works);
        const promptPolicyUpgradeOnly = (
            addition.compatible &&
            addition.addedWorkIds.length === 0 &&
            (saved.atlasPromptPolicyVersion || 1) < atlasPromptPolicyVersion
        );
        if (addition.compatible && (addition.addedWorkIds.length > 0 || promptPolicyUpgradeOnly)) {
            const cachedWarnings = [];
            const cachedAtlas = validateAtlas(saved.atlas, corpus, works, warning => cachedWarnings.push(warning));
            if (cachedWarnings.length > 0) {
                throw new Error(`${corpus}: incrementally reused atlas unexpectedly required ${cachedWarnings.length} reference repairs.`);
            }
            const reuseMetadata = promptPolicyUpgradeOnly
                ? { policyUpgradedAt: new Date().toISOString() }
                : {
                    incrementallyExtendedAt: new Date().toISOString(),
                    lastAddedWorkIds: addition.addedWorkIds
                };
            writeJsonAtomic(paths.atlasRecord, {
                ...saved,
                inputHash,
                atlasPromptPolicyVersion,
                basis: addition.currentBasis,
                ...reuseMetadata
            });
            progressLog(`curation:${corpus}`, promptPolicyUpgradeOnly
                ? 'reusing stable global atlas after deterministic selection-policy upgrade; no Codex call needed'
                : `reusing stable global atlas for ${addition.addedWorkIds.length} added works; only new works and affected author rosters will be curated`);
            return cachedAtlas;
        }
    }
    if (rebuildPortfolioOnly) throw new Error(`${corpus}: cached atlas is missing or incompatible.`);
    const outputPath = path.join(paths.temporaryDir, 'atlas-output.json');
    const atlasProgress = new ProgressTracker({ scope: `curation:${corpus}:atlas`, total: 1 });
    atlasProgress.start('atlas', 1, `${works.length} works; ${countTokens(prompt).tokens} prompt tokens`);
    let atlas;
    let validationWarnings = [];
    try {
        atlas = await withRetries(`${corpus} atlas`, async attempt => {
            const raw = await runCodexPrompt({ prompt, schemaPath: atlasSchemaPath, outputPath });
            writeJsonAtomic(path.join(paths.temporaryDir, `atlas-attempt-${attempt}.json`), raw);
            try {
                const attemptWarnings = [];
                const validated = validateAtlas(raw, corpus, works, warning => attemptWarnings.push(warning));
                validationWarnings = attemptWarnings;
                return validated;
            } catch (error) {
                const validationError = new Error(`Atlas validation failed: ${error.message}`);
                validationError.nonRetryable = true;
                validationError.cause = error;
                throw validationError;
            }
        });
        const repairNote = validationWarnings.length > 0
            ? `validated; omitted ${validationWarnings.length} invalid optional references`
            : 'validated';
        atlasProgress.complete('atlas', repairNote);
    } catch (error) {
        atlasProgress.fail('atlas', error);
        throw error;
    } finally {
        atlasProgress.dispose();
    }
    writeJsonAtomic(paths.atlas, atlas);
    writeJsonAtomic(paths.atlasRecord, {
        contractVersion: curationContractVersion,
        atlasPromptPolicyVersion,
        inputHash,
        model: model || null,
        reasoningEffort,
        generatedAt: new Date().toISOString(),
        validationWarnings,
        basis: buildAtlasBasis(corpus, works),
        atlas
    });
    if (validationWarnings.length > 0) {
        progressLog(`curation:${corpus}`, `atlas retained with ${validationWarnings.length} validation warnings recorded in atlas-record.json`);
        for (const warning of validationWarnings.slice(0, 10)) {
            progressLog(`curation:${corpus}:atlas`, `${warning.code}: ${warning.message}`);
        }
        if (validationWarnings.length > 10) {
            progressLog(`curation:${corpus}:atlas`, `${validationWarnings.length - 10} additional warnings omitted from console; see atlas-record.json`);
        }
    }
    progressLog(`curation:${corpus}`, `global atlas persisted to ${path.relative(projectRoot, paths.atlasRecord)}`);
    return atlas;
}

function resultPath(paths, id) {
    return path.join(paths.resultDir, `${id}.json`);
}

function loadCachedDecision(paths, work, roster, atlasHash) {
    const saved = readJsonIfExists(resultPath(paths, work.id));
    const inputHash = curationInputHash(work, roster, atlasHash);
    if (
        saved?.contractVersion !== curationContractVersion ||
        saved?.inputHash !== inputHash ||
        saved?.result?.id !== work.id
    ) return null;
    return saved.result;
}

async function curateBatch(corpus, atlas, batch, paths) {
    const atlasHash = stableHash(atlas);
    const groupByWorkId = new Map(batch.groups.flatMap(group => group.roster.map(work => [work.id, group])));
    const pending = batch.decisionWorks.filter(work => {
        const group = groupByWorkId.get(work.id);
        return !loadCachedDecision(paths, work, group.roster, atlasHash);
    });
    if (pending.length === 0) return 0;
    const pendingIds = new Set(pending.map(work => work.id));
    const activeBatch = {
        ...batch,
        decisionWorks: pending,
        groups: batch.groups.map(group => ({
            ...group,
            decisionWorks: group.decisionWorks.filter(work => pendingIds.has(work.id))
        })).filter(group => group.decisionWorks.length > 0)
    };
    const prompt = buildCurationPrompt(corpus, atlas, activeBatch);
    const outputPath = path.join(paths.temporaryDir, `${batch.batchId}-output.json`);
    const validated = await withRetries(`${corpus}/${batch.batchId}`, async attempt => {
        const raw = await runCodexPrompt({ prompt, schemaPath: resultSchemaPath, outputPath });
        writeJsonAtomic(path.join(paths.temporaryDir, `${batch.batchId}-attempt-${attempt}.json`), raw);
        return validateCurationBatch(raw, atlas, activeBatch);
    });
    const results = validated.results;
    for (const result of results) {
        const group = groupByWorkId.get(result.id);
        const work = group.roster.find(item => item.id === result.id);
        const validationWarnings = validated.validationWarnings.filter(warning => warning.workId === result.id);
        writeJsonAtomic(resultPath(paths, result.id), {
            contractVersion: curationContractVersion,
            atlasHash,
            inputHash: curationInputHash(work, group.roster, atlasHash),
            model: model || null,
            reasoningEffort,
            generatedAt: new Date().toISOString(),
            validationWarnings,
            result
        });
    }
    progressLog(
        `curation:${corpus}`,
        `${batch.batchId}: saved ${results.length} decisions${validated.validationWarnings.length ? `; omitted/repaired ${validated.validationWarnings.length} invalid optional references` : ''}`
    );
    return results.length;
}

function rebuildPortfolio(corpus, works, atlas, paths) {
    const atlasHash = stableHash(atlas);
    const groups = groupWorksByCreator(works);
    const decisions = [];
    const missing = [];
    for (const work of works) {
        const roster = groups.get(leadCreatorKey(work.author));
        const decision = loadCachedDecision(paths, work, roster, atlasHash);
        if (decision) decisions.push(decision);
        else missing.push(work.id);
    }
    if (missing.length) return { portfolio: null, missing };
    const portfolio = buildPortfolio(corpus, works, atlas, decisions);
    writeJsonAtomic(paths.portfolio, portfolio);
    return { portfolio, missing: [] };
}

function writeCombinedPortfolio(results) {
    const currentResults = new Map(results.map(result => [result.corpus, result]));
    const corpusEntries = {};
    for (const corpus of config.corpora) {
        const current = currentResults.get(corpus);
        if (current) {
            corpusEntries[corpus] = current.portfolio || {
                corpus,
                incomplete: true,
                missingWorkIds: current.missing
            };
            continue;
        }
        const saved = readJsonIfExists(corpusPaths(corpus).portfolio);
        corpusEntries[corpus] = saved?.corpus === corpus && Array.isArray(saved.works)
            ? saved
            : { corpus, incomplete: true, missingWorkIds: [] };
    }
    const complete = config.corpora.every(corpus => (
        Array.isArray(corpusEntries[corpus]?.works) && !corpusEntries[corpus].incomplete
    ));
    writeJsonAtomic(path.join(curationDir, 'portfolio.json'), {
        version: 1,
        contractVersion: curationContractVersion,
        generatedAt: new Date().toISOString(),
        complete,
        corpora: corpusEntries
    });
    return complete;
}

function buildPlan(catalog) {
    const details = [];
    for (const corpus of corpora) {
        const works = catalog.works.filter(work => work.target === corpus);
        const atlasPrompt = buildAtlasPrompt(corpus, works);
        const batches = buildCurationBatches(works, batchSize);
        details.push({
            corpus,
            workCount: works.length,
            authorCount: groupWorksByCreator(works).size,
            atlasPromptCharacters: atlasPrompt.length,
            atlasPromptTokens: countTokens(atlasPrompt),
            curationBatchCount: batches.length,
            largestBatchPrompt: batches.reduce((largest, batch) => {
                const mockAtlas = {
                    corpus,
                    mission_summary_cz: '',
                    focus_areas: [{ key: 'placeholder', title_cz: '', description_cz: '', weight: 1, minimum_distinct_authors: 1 }],
                    must_include_works: [], author_policies: [], exact_duplicate_groups: [], containment_relations: [], selection_rules_cz: []
                };
                const prompt = buildCurationPrompt(corpus, mockAtlas, batch);
                const tokens = countTokens(prompt);
                return tokens.tokens > largest.tokens ? { batchId: batch.batchId, characters: prompt.length, ...tokens } : largest;
            }, { batchId: '', characters: 0, tokens: 0, byEncoding: {} })
        });
    }
    const report = { generatedAt: new Date().toISOString(), contractVersion: curationContractVersion, corpora: details };
    ensureDirectory(reportsDir);
    writeJsonAtomic(path.join(reportsDir, 'curation-plan.json'), report);
    console.log(JSON.stringify(report, null, 2));
}

async function main() {
    for (const corpus of corpora) if (!config.corpora.includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
    const catalog = readJsonIfExists(catalogPath);
    if (!catalog?.works || catalog.summary?.unclassifiedCandidateCount > 0) {
        throw new Error(`Curation requires a complete ${path.relative(projectRoot, catalogPath)}.`);
    }
    if (planOnly) {
        buildPlan(catalog);
        return;
    }
    const release = acquireLock();
    try {
        const results = [];
        let remainingBatchBudget = maximumBatches;
        for (const corpus of corpora) {
            const works = catalog.works.filter(work => work.target === corpus);
            progressLog(`curation:${corpus}`, `starting corpus with ${works.length} classified works; batch-size=${batchSize}; concurrency=${concurrency}; model=${model || 'Codex config'}; reasoning=${reasoningEffort}`);
            const paths = corpusPaths(corpus);
            ensureDirectory(paths.resultDir);
            ensureDirectory(paths.temporaryDir);
            const atlas = await loadOrCreateAtlas(corpus, works, paths);
            if (!atlasOnly && !rebuildPortfolioOnly && remainingBatchBudget > 0) {
                const batches = buildCurationBatches(works, batchSize);
                const pendingBatches = batches.filter(batch => batch.decisionWorks.some(work => (
                    !loadCachedDecision(
                        paths,
                        work,
                        batch.groups.find(group => group.roster.some(item => item.id === work.id)).roster,
                        stableHash(atlas)
                    )
                )));
                const pending = pendingBatches.slice(0, remainingBatchBudget);
                remainingBatchBudget -= pending.length;
                progressLog(`curation:${corpus}`, `${batches.length - pendingBatches.length}/${batches.length} batches cached; ${pending.length} scheduled now; ${pendingBatches.length - pending.length} deferred by --max-batches`);
                if (pending.length) {
                    const progress = new ProgressTracker({ scope: `curation:${corpus}`, total: pending.length });
                    try {
                        await mapLimit(pending, concurrency, async (batch, index) => {
                            const progressId = `${corpus}-${batch.batchId}`;
                            progress.start(progressId, index + 1, `${batch.batchId}; ${batch.decisionWorks.length} decisions`);
                            try {
                                const saved = await curateBatch(corpus, atlas, batch, paths);
                                progress.complete(progressId, `${saved} decisions persisted`);
                            } catch (error) {
                                progress.fail(progressId, error);
                                throw error;
                            }
                        });
                    } finally {
                        progress.dispose();
                    }
                }
            }
            progressLog(`curation:${corpus}`, 'rebuilding deterministic portfolio from persisted decisions');
            const rebuilt = rebuildPortfolio(corpus, works, atlas, paths);
            results.push({ corpus, ...rebuilt });
            if (rebuilt.portfolio) console.log(`${corpus}: complete portfolio with ${rebuilt.portfolio.works.length} works.`);
            else console.log(`${corpus}: ${rebuilt.missing.length} curation decisions still missing.`);
        }
        writeCombinedPortfolio(results);
        const requestedComplete = results.every(result => result.portfolio);
        if (!requestedComplete && maximumBatches === Number.MAX_SAFE_INTEGER && !atlasOnly) process.exitCode = 2;
    } finally {
        release();
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});

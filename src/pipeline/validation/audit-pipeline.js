'use strict';

const fs = require('fs');
const path = require('path');
const {
    config,
    projectRoot,
    readJsonIfExists,
    resolveProjectPath,
    writeJsonAtomic
} = require('../../lib/corpus-pipeline');
const { countTokens } = require('../../lib/token-counter');
const { inspectMarkdownQuality } = require('../../lib/markdown-quality');
const { prepareContainmentAlternatives } = require('../../lib/portfolio-selector');
const { progressLog, ProgressTracker } = require('../../lib/progress');

const stateDir = resolveProjectPath(config.stateDir);
const booksDir = resolveProjectPath(config.booksDir);
const markdownDir = resolveProjectPath(config.markdownDir);
const mergedDir = resolveProjectPath(config.mergedDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const allowPartial = process.argv.includes('--allow-partial');
const requestedCorpus = process.argv.find(argument => argument.startsWith('--corpus='))?.slice('--corpus='.length);
const corpora = requestedCorpus ? [requestedCorpus] : config.corpora;
const issues = [];

function addIssue(severity, code, message, details = {}) {
    issues.push({ severity, code, message, ...details });
}

function listMarkdownFiles(directoryPath) {
    if (!fs.existsSync(directoryPath)) return [];
    return fs.readdirSync(directoryPath)
        .filter(name => name.toLowerCase().endsWith('.md'))
        .sort((a, b) => a.localeCompare(b));
}

function inspectConvertedMarkdown(filePath, workId, corpus) {
    if (!fs.existsSync(filePath)) {
        addIssue(
            'warning',
            'conversion_failed',
            `Převod díla selhal a zdroj bude z výsledného korpusu vynechán: ${filePath}`,
            { corpus, workId }
        );
        return null;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const inspected = inspectMarkdownQuality(text);
    const bytes = inspected.bytes;
    const words = inspected.words;
    const replacementCharacters = (text.match(/\uFFFD/g) || []).length;
    const firstSample = text.slice(0, 5000);
    const lastSample = text.slice(-5000);
    const flags = [];
    flags.push(...inspected.hardReasons, ...inspected.warnings);
    if (/PRAISE FOR|promotional download/i.test(firstSample)) flags.push('frontmatter_noise');
    if (/what(?:'|’)s next on your reading list|also of interest/i.test(lastSample)) flags.push('endmatter_marketing');
    return { bytes, words, replacementCharacters, flags };
}

function auditIndexLinks(corpus, directoryPath, expectedNames = listMarkdownFiles(directoryPath)) {
    const firstFile = expectedNames.find(name => /^01_/i.test(name));
    if (!firstFile) {
        addIssue('error', 'missing_embedded_index', `Chybí první soubor 01 s rozcestníkem pro ${corpus}.`, { corpus });
        return;
    }
    const indexPath = path.join(directoryPath, firstFile);
    const content = fs.readFileSync(indexPath, 'utf8');
    if (!content.startsWith(`# Rozcestník — ${corpus}`)) {
        addIssue('error', 'missing_embedded_index', `První soubor ${firstFile} nezačíná rozcestníkem.`, { corpus });
    }
    const linkPattern = /\]\(\.\/([^#)]+)#([^)]+)\)/g;
    const expectedNameSet = new Set(expectedNames);
    const linkedNames = new Set();
    let match = linkPattern.exec(content);
    while (match) {
        const targetPath = path.join(directoryPath, match[1]);
        linkedNames.add(match[1]);
        if (!expectedNameSet.has(match[1])) {
            addIssue('error', 'stale_index_file_link', `Index ${corpus} odkazuje na ${match[1]}, který není ve finálním manifestu souborů.`, { corpus });
        } else if (!fs.existsSync(targetPath)) {
            addIssue('error', 'broken_index_file_link', `Index ${corpus} odkazuje na chybějící ${match[1]}.`, { corpus });
        } else {
            const target = fs.readFileSync(targetPath, 'utf8');
            if (!target.includes(`id="${match[2]}"`)) {
                addIssue('error', 'broken_index_anchor', `Index ${corpus} odkazuje na chybějící kotvu ${match[2]}.`, { corpus, file: match[1] });
            }
        }
        match = linkPattern.exec(content);
    }
    for (const expectedName of expectedNames) {
        if (!linkedNames.has(expectedName)) {
            addIssue('error', 'unlinked_final_file', `Finální soubor ${expectedName} nemá žádný odkaz v globálním rozcestníku ${corpus}.`, { corpus });
        }
    }
}

function renderAuditMarkdown(report) {
    const lines = [
        '# Audit pipeline',
        '',
        `Vygenerováno: ${report.generatedAt}`,
        '',
        `Výsledek: ${report.ok ? 'OK' : 'CHYBA'}; chyby: ${report.summary.errors}; varování: ${report.summary.warnings}.`,
        ''
    ];
    for (const corpus of report.corpora) {
        lines.push(
            `## ${corpus.corpus}`,
            '',
            `Klasifikovaná díla: ${corpus.catalogWorks}; staged: ${corpus.stagedWorks}; Markdown: ${corpus.markdownFiles}; vybraná do uploadu: ${corpus.selectedWorks}.`,
            '',
            `Finální soubory: ${corpus.finalFiles}; největší: ${(corpus.largestFinalBytes / 1024 / 1024).toFixed(2)} MiB / ${corpus.largestFinalTokens.toLocaleString('cs-CZ')} tokenů.`,
            ''
        );
    }
    if (report.issues.length) {
        lines.push('## Nálezy', '');
        for (const issue of report.issues) {
            lines.push(`- **${issue.severity.toUpperCase()} ${issue.code}:** ${issue.message}`);
        }
        lines.push('');
    }
    return `${lines.join('\n')}\n`;
}

function main() {
    for (const corpus of corpora) {
        if (!config.corpora.includes(corpus)) throw new Error(`Unknown corpus: ${corpus}`);
    }
    const catalog = readJsonIfExists(path.join(stateDir, 'catalog.json'));
    if (!catalog) {
        throw new Error(`Missing ${path.relative(projectRoot, path.join(stateDir, 'catalog.json'))}.`);
    }
    if (catalog.summary.unclassifiedCandidateCount > 0) {
        addIssue(
            allowPartial ? 'warning' : 'error',
            'classification_incomplete',
            `Zbývá ${catalog.summary.unclassifiedCandidateCount} neklasifikovaných kandidátů.`
        );
    }
    const workTargets = new Map(catalog.works.map(work => [work.id, work.target]));
    const portfolioDocument = readJsonIfExists(path.join(stateDir, 'curation', 'portfolio.json'));
    for (const corpus of corpora) {
        const curation = portfolioDocument?.corpora?.[corpus];
        if (!Array.isArray(curation?.works) || curation.incomplete) {
            addIssue('error', 'curation_incomplete', `Chybí kompletní kurátorské portfolio pro ${corpus}.`, { corpus });
        }
    }
    const corpusReports = [];
    progressLog('audit', `starting; scope=${requestedCorpus || 'all corpora'}; catalog works=${catalog.works.length}`);

    for (const work of catalog.works.filter(work => corpora.includes(work.target))) {
        if (work.reviewFlags?.length) {
            addIssue(
                'warning',
                'catalog_review_flag',
                `${work.author} — ${work.title}: ${work.reviewFlags.join(', ')}`,
                { workId: work.id, target: work.target }
            );
        }
    }

    for (const corpus of corpora) {
        progressLog(`audit:${corpus}`, 'checking curation, staged sources and converted Markdown');
        const manifestPath = path.join(booksDir, corpus, 'manifest.json');
        const manifest = readJsonIfExists(manifestPath, { entries: [] });
        const conversionPlan = readJsonIfExists(path.join(stateDir, 'conversion-plans', `${corpus}.json`));
        const curatedEntries = portfolioDocument?.corpora?.[corpus]?.works || [];
        const excludedFromStagingIds = new Set(curatedEntries
            .filter(work => work.exactDuplicate)
            .map(work => work.workId));
        const eligibleWorks = catalog.works.filter(work => work.target === corpus && !excludedFromStagingIds.has(work.id));
        const eligibleById = new Map(eligibleWorks.map(work => [work.id, work]));
        const plannedIds = conversionPlan?.selectedWorkIds
            ? new Set(conversionPlan.selectedWorkIds)
            : new Set(eligibleWorks.map(work => work.id));
        const expectedWorks = [...plannedIds].map(id => eligibleById.get(id)).filter(Boolean);
        for (const id of plannedIds) {
            if (!eligibleById.has(id)) {
                addIssue('error', 'stale_conversion_plan_entry', `${corpus}: plán převodu odkazuje na neplatné dílo ${id}.`, { corpus, workId: id });
            }
        }
        if (conversionPlan && conversionPlan.totalEligibleWorkCount !== eligibleWorks.length) {
            addIssue('error', 'stale_conversion_plan_count', `${corpus}: plán převodu neodpovídá aktuálnímu počtu způsobilých děl.`, { corpus });
        }
        const manifestIds = new Set((manifest.entries || []).map(entry => entry.workId));
        const entryProgress = new ProgressTracker({ scope: `audit:${corpus}:entries`, total: expectedWorks.length + (manifest.entries || []).length });
        for (const work of expectedWorks) {
            if (!manifestIds.has(work.id)) {
                addIssue('error', 'unstaged_work', `${corpus}: katalogové dílo není v books: ${work.author} — ${work.title}`, { corpus, workId: work.id });
            }
            entryProgress.advance(`catalog ${work.title}`);
        }
        for (const entry of manifest.entries || []) {
            if (!plannedIds.has(entry.workId)) {
                addIssue('error', 'unplanned_staged_work', `${corpus}: staged dílo není v aktuálním plánu převodu: ${entry.title}.`, { corpus, workId: entry.workId });
            }
            if (workTargets.get(entry.workId) !== corpus) {
                addIssue('error', 'wrong_target_folder', `${entry.title} je ve špatné cílové složce ${corpus}.`, { corpus, workId: entry.workId });
            }
            const sourcePath = path.join(resolveProjectPath(config.sourceDir), entry.sourceRelativePath);
            const stagedPath = path.join(booksDir, corpus, entry.outputName);
            if (!fs.existsSync(sourcePath)) addIssue('error', 'missing_source', `Chybí originál ${sourcePath}.`, { corpus, workId: entry.workId });
            if (!fs.existsSync(stagedPath)) addIssue('error', 'missing_staged_file', `Chybí staged soubor ${stagedPath}.`, { corpus, workId: entry.workId });

            const baseName = path.basename(entry.outputName, path.extname(entry.outputName));
            const quality = inspectConvertedMarkdown(
                path.join(markdownDir, corpus, `${baseName}.md`),
                entry.workId,
                corpus
            );
            if (quality?.flags.length) {
                addIssue('warning', 'markdown_quality', `${corpus}: ${entry.title}: ${quality.flags.join(', ')}`, {
                    corpus,
                    workId: entry.workId,
                    quality
                });
            }
            entryProgress.advance(`manifest ${entry.title}`);
        }
        entryProgress.dispose();
        const expectedMarkdownNames = new Set((manifest.entries || []).map(entry => (
            `${path.basename(entry.outputName, path.extname(entry.outputName))}.md`
        )));
        const actualMarkdownNames = listMarkdownFiles(path.join(markdownDir, corpus));
        for (const name of actualMarkdownNames) {
            if (!expectedMarkdownNames.has(name)) {
                addIssue('error', 'orphaned_markdown', `${corpus}: převedený Markdown není v aktuálním conversion frontier: ${name}.`, { corpus, file: name });
            }
        }

        const mergeReport = readJsonIfExists(path.join(reportsDir, 'merge', `${corpus}.json`));
        if (!mergeReport) {
            addIssue('error', 'missing_merge_report', `Chybí merge report pro ${corpus}.`, { corpus });
        }
        const finalDirectory = path.join(mergedDir, corpus);
        const finalNames = mergeReport?.files?.map(file => file.fileName) || [];
        const selectedIds = new Set((mergeReport?.selected || []).map(entry => entry.id));
        for (const id of selectedIds) {
            if (!manifestIds.has(id)) {
                addIssue('error', 'selected_unconverted_work', `${corpus}: finální výběr obsahuje dílo mimo plán převodu ${id}.`, { corpus, workId: id });
            }
        }
        const selectedContainment = prepareContainmentAlternatives(curatedEntries
            .filter(work => !work.exactDuplicate)
            .map(work => ({ ...work, id: work.workId })))
            .filter(work => selectedIds.has(work.id));
        for (let leftIndex = 0; leftIndex < selectedContainment.length; leftIndex++) {
            const left = selectedContainment[leftIndex];
            const leftContent = new Set(left.contentIdentityIds);
            for (let rightIndex = leftIndex + 1; rightIndex < selectedContainment.length; rightIndex++) {
                const right = selectedContainment[rightIndex];
                const shared = right.contentIdentityIds.filter(id => leftContent.has(id));
                if (!shared.length) continue;
                addIssue(
                    'error',
                    'selected_containment_overlap',
                    `${corpus}: finální výběr současně obsahuje překrývající se celek/část ${left.title} a ${right.title}.`,
                    { corpus, leftWorkId: left.id, rightWorkId: right.id, sharedWorkIds: shared }
                );
            }
        }
        if (
            mergeReport &&
            mergeReport.selectedBookCount + mergeReport.excludedBookCount !== eligibleWorks.length
        ) {
            addIssue(
                'error',
                'incomplete_merge_accounting',
                `${corpus}: merge report eviduje ${mergeReport.selectedBookCount + mergeReport.excludedBookCount}/${eligibleWorks.length} způsobilých děl.`,
                { corpus }
            );
        }
        for (const name of finalNames) {
            if (!fs.existsSync(path.join(finalDirectory, name))) {
                addIssue('error', 'missing_merged_file', `${corpus}: merge report odkazuje na chybějící ${name}.`, { corpus, file: name });
            }
        }
        const existingFinalNames = finalNames.filter(name => fs.existsSync(path.join(finalDirectory, name)));
        for (const name of listMarkdownFiles(finalDirectory)) {
            if (!finalNames.includes(name)) {
                addIssue('error', 'orphaned_merged_file', `${corpus}: ve finální složce zůstal soubor mimo merge report: ${name}.`, { corpus, file: name });
            }
        }
        const actualSizes = existingFinalNames.map(name => fs.statSync(path.join(finalDirectory, name)).size);
        const finalProgress = new ProgressTracker({ scope: `audit:${corpus}:final`, total: existingFinalNames.length });
        const actualTokens = existingFinalNames.map((name, index) => {
            const progressId = `audit-final-${index}`;
            finalProgress.start(progressId, index + 1, name);
            try {
                return countTokens(fs.readFileSync(path.join(finalDirectory, name), 'utf8'));
            } finally {
                finalProgress.complete(progressId, 'tokenized');
            }
        });
        finalProgress.dispose();
        const largestFinalBytes = actualSizes.length ? Math.max(...actualSizes) : 0;
        const largestFinalTokens = actualTokens.length ? Math.max(...actualTokens.map(item => item.tokens)) : 0;
        if (finalNames.length > config.upload.maxBookFiles) {
            addIssue('error', 'too_many_upload_files', `${corpus} má ${finalNames.length} knižních souborů, limit je ${config.upload.maxBookFiles}.`, { corpus });
        }
        if (finalNames.length + config.upload.reservedExternalKnowledgeFiles > config.upload.maxKnowledgeFiles) {
            addIssue('error', 'too_many_total_knowledge_files', `${corpus} s rezervovanými externími soubory překračuje ${config.upload.maxKnowledgeFiles} Knowledge souborů.`, { corpus });
        }
        if (largestFinalBytes > config.upload.maxFileSizeBytes) {
            addIssue('error', 'upload_file_too_large', `${corpus} má soubor ${largestFinalBytes} B, limit je ${config.upload.maxFileSizeBytes} B.`, { corpus });
        }
        if (largestFinalTokens > config.upload.maxTokensPerFile) {
            addIssue('error', 'upload_file_too_many_tokens', `${corpus} má soubor s ${largestFinalTokens} tokeny, limit je ${config.upload.maxTokensPerFile}.`, { corpus });
        }
        if (mergeReport && (!mergeReport.validation.fileCountWithinLimit || !mergeReport.validation.fileSizeWithinLimit)) {
            addIssue('error', 'merge_validation_failed', `Merge report ${corpus} nemá splněné tvrdé limity.`, { corpus });
        }
        if (mergeReport && !mergeReport.validation.tokenCountWithinLimit) {
            addIssue('error', 'merge_token_count_failed', `Merge report ${corpus} překračuje skutečný tokenový limit.`, { corpus });
        }
        auditIndexLinks(corpus, finalDirectory, finalNames);
        corpusReports.push({
            corpus,
            catalogWorks: eligibleWorks.length,
            stagedWorks: manifest.entries?.length || 0,
            markdownFiles: actualMarkdownNames.length,
            conversionCandidateWorks: expectedWorks.length,
            selectedWorks: mergeReport?.selectedBookCount || 0,
            excludedWorks: mergeReport?.excludedBookCount || 0,
            finalFiles: finalNames.length,
            largestFinalBytes,
            largestFinalTokens,
            finalBytes: actualSizes.reduce((sum, bytes) => sum + bytes, 0)
        });
        progressLog(`audit:${corpus}`, `complete: staged=${manifest.entries?.length || 0}; final files=${finalNames.length}; issues so far=${issues.length}`);
    }

    const errors = issues.filter(issue => issue.severity === 'error').length;
    const warnings = issues.filter(issue => issue.severity === 'warning').length;
    const report = {
        generatedAt: new Date().toISOString(),
        ok: errors === 0,
        partialAllowed: allowPartial,
        scope: requestedCorpus || 'all',
        summary: { errors, warnings },
        catalogSummary: catalog.summary,
        corpora: corpusReports,
        issues
    };
    const reportBase = requestedCorpus ? `audit-${requestedCorpus}` : 'audit';
    writeJsonAtomic(path.join(reportsDir, `${reportBase}.json`), report);
    fs.writeFileSync(path.join(reportsDir, `${reportBase}.md`), renderAuditMarkdown(report), 'utf8');
    console.log(renderAuditMarkdown(report));
    console.log(`Audit report: ${path.relative(projectRoot, path.join(reportsDir, `${reportBase}.json`))}`);
    progressLog('audit', `complete: errors=${errors}; warnings=${warnings}`);
    if (!report.ok) process.exitCode = 1;
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

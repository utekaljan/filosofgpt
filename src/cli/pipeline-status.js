'use strict';

const fs = require('fs');
const path = require('path');
const { config, readJsonIfExists, resolveProjectPath } = require('../lib/corpus-pipeline');

const stateDir = resolveProjectPath(config.stateDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const candidateDocument = readJsonIfExists(path.join(stateDir, 'candidates.json'), { candidates: [] });
const classificationDirectory = path.join(stateDir, 'classification', 'by-id');
const classifiedIds = fs.existsSync(classificationDirectory)
    ? new Set(fs.readdirSync(classificationDirectory).filter(name => name.endsWith('.json')).map(name => path.basename(name, '.json')))
    : new Set();
const candidateIds = new Set(candidateDocument.candidates.map(candidate => candidate.id));
const classified = [...classifiedIds].filter(id => candidateIds.has(id)).length;
const total = candidateIds.size;
const catalog = readJsonIfExists(path.join(stateDir, 'catalog.json'));
const portfolio = readJsonIfExists(path.join(stateDir, 'curation', 'portfolio.json'));
const masterRun = readJsonIfExists(path.join(stateDir, 'master', 'run.json'));

if (masterRun) {
    const stage = masterRun.currentStage?.script ? `; stage=${masterRun.currentStage.script}` : '';
    console.log(`Master: ${masterRun.status}${stage}; updated ${masterRun.updatedAt}.`);
}

console.log(`Classification: ${classified}/${total} (${total ? (classified / total * 100).toFixed(1) : '0.0'} %)`);
if (catalog) {
    console.log(`Catalog: ${catalog.summary.canonicalWorkCount} canonical works; targets ${JSON.stringify(catalog.summary.byTarget)}.`);
}
for (const corpus of config.corpora) {
    const targetWorks = catalog?.works?.filter(work => work.target === corpus) || [];
    const curationDirectory = path.join(stateDir, 'curation', corpus, 'by-id');
    const curatedIds = fs.existsSync(curationDirectory)
        ? new Set(fs.readdirSync(curationDirectory).filter(name => name.endsWith('.json')).map(name => path.basename(name, '.json')))
        : new Set();
    const curated = targetWorks.filter(work => curatedIds.has(work.id)).length;
    const conversion = readJsonIfExists(path.join(reportsDir, 'conversion', `${corpus}.json`), []);
    const merge = readJsonIfExists(path.join(reportsDir, 'merge', `${corpus}.json`));
    const finalFileCount = merge?.validation?.finalBookFileCount ?? merge?.files?.length ?? 0;
    const plan = readJsonIfExists(path.join(stateDir, 'conversion-plans', `${corpus}.json`));
    const planText = plan ? `; conversion frontier ${plan.plannedWorkCount}/${plan.totalEligibleWorkCount}` : '';
    console.log(`${corpus}: curated ${curated}/${targetWorks.length}${planText}; converted ${conversion.filter(entry => !entry.skipped).length}; final ${merge?.selectedBookCount ?? 0} works in ${finalFileCount} files.`);
}
console.log(`Curation portfolio: ${portfolio?.complete ? 'complete' : 'incomplete or missing'}.`);
const audit = readJsonIfExists(path.join(reportsDir, 'audit.json'));
if (audit) console.log(`Last audit: ${audit.ok ? 'OK' : 'FAILED'}, errors=${audit.summary.errors}, warnings=${audit.summary.warnings}, ${audit.generatedAt}.`);

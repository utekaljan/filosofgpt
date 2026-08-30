'use strict';

const fs = require('fs');
const path = require('path');
const {
    config,
    readJsonIfExists,
    resolveProjectPath,
    writeJsonAtomic
} = require('../../lib/corpus-pipeline');

const stateDir = resolveProjectPath(config.stateDir);
const reportsDir = resolveProjectPath(config.reportsDir);
const booksDir = resolveProjectPath(config.booksDir);

function main() {
    const catalog = readJsonIfExists(path.join(stateDir, 'catalog.json'));
    const portfolio = readJsonIfExists(path.join(stateDir, 'curation', 'portfolio.json'), { corpora: {} });
    if (!catalog?.works) throw new Error('Missing catalog for decisions report.');
    const decisions = [];
    for (const work of catalog.works) {
        if (work.target === 'null') {
            decisions.push({
                id: work.id,
                source: work.primarySource?.relativePath,
                author: work.author,
                title: work.title,
                target: 'null',
                outcome: 'rejected_semantic',
                classificationReasonCz: work.reasonCz,
                curationReasonCz: '',
                selectionReason: 'semantic_target_null',
                qualityPreflight: work.qualityPreflight,
                qualityWarnings: []
            });
            continue;
        }
        const curated = portfolio.corpora?.[work.target]?.works?.find(entry => entry.workId === work.id);
        const merge = readJsonIfExists(path.join(reportsDir, 'merge', `${work.target}.json`), { selected: [], excluded: [] });
        const selected = merge.selected?.find(entry => entry.id === work.id);
        const excluded = merge.excluded?.find(entry => entry.id === work.id);
        const manifest = readJsonIfExists(path.join(booksDir, work.target, 'manifest.json'), { entries: [] });
        const staged = manifest.entries?.find(entry => entry.workId === work.id);
        decisions.push({
            id: work.id,
            source: work.primarySource?.relativePath,
            author: work.author,
            title: work.title,
            target: work.target,
            outcome: selected ? 'selected' : (excluded ? 'excluded_after_conversion' : (staged ? 'not_selected' : 'not_staged')),
            classificationReasonCz: work.reasonCz,
            curationReasonCz: curated?.reasonCz || '',
            selectionReason: selected ? 'selected_for_merged_package' : (excluded?.reason || staged?.conversionReason || 'not_selected'),
            qualityPreflight: work.qualityPreflight,
            qualityWarnings: selected?.qualityWarnings || excluded?.qualityWarnings || [],
            postprocessing: selected?.postprocessing || null,
            convertedBytes: selected?.bytes || excluded?.bytes || null,
            convertedTokens: selected?.tokenCount || excluded?.tokenCount || null
        });
    }
    decisions.sort((a, b) => a.target.localeCompare(b.target) || a.author.localeCompare(b.author) || a.title.localeCompare(b.title));
    const summary = {
        total: decisions.length,
        selected: decisions.filter(entry => entry.outcome === 'selected').length,
        rejectedSemantic: decisions.filter(entry => entry.outcome === 'rejected_semantic').length,
        excludedAfterConversion: decisions.filter(entry => entry.outcome === 'excluded_after_conversion').length,
        other: decisions.filter(entry => !['selected', 'rejected_semantic', 'excluded_after_conversion'].includes(entry.outcome)).length
    };
    const report = { version: 1, summary, decisions };
    writeJsonAtomic(path.join(reportsDir, 'decisions.json'), report);
    const lines = ['# Rozhodnutí pipeline', '', `Celkem: ${summary.total}; vybráno: ${summary.selected}; tematicky vyřazeno: ${summary.rejectedSemantic}; po převodu vyřazeno: ${summary.excludedAfterConversion}.`, ''];
    for (const entry of decisions) {
        lines.push(
            `## ${entry.author} — ${entry.title}`,
            '',
            `- Výsledek: ${entry.outcome}`,
            `- Cíl: ${entry.target}`,
            `- Zdroj: ${entry.source}`,
            `- Klasifikace: ${entry.classificationReasonCz}`,
            ...(entry.curationReasonCz ? [`- Kurace: ${entry.curationReasonCz}`] : []),
            `- Výběr/kvalita: ${entry.selectionReason}`,
            `- Preflight: ${entry.qualityPreflight?.status || 'unknown'}`,
            ...(entry.qualityWarnings.length ? [`- Varování: ${entry.qualityWarnings.join(', ')}`] : []),
            ''
        );
    }
    fs.writeFileSync(path.join(reportsDir, 'decisions.md'), `${lines.join('\n')}\n`, 'utf8');
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

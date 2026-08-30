'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('merge embeds the index, uses curated metadata and preserves source prose including noisy lines', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-merge-test-'));
    try {
        const input = path.join(root, 'input');
        const output = path.join(root, 'output');
        const manifestPath = path.join(root, 'manifest.json');
        const reportPath = path.join(root, 'report.json');
        fs.mkdirSync(input, { recursive: true });
        const entries = [];
        const definitions = [
            ['lantern', 'Fixture Author Alpha', 'Synthetic Work Alpha', 'fixture author alpha', 1],
            ['bridge', 'Fixture Author Beta', 'Synthetic Work Beta', 'fixture author beta', 1],
            ['archive-a', 'Fixture Author Gamma', 'Synthetic Work Gamma', 'fixture author gamma', 8],
            ['measure', 'Fixture Author Delta', 'Synthetic Work Delta', 'fixture author delta', 12]
        ];
        for (const [id, author, title, creatorKey, creatorWorkCount] of definitions) {
            const outputName = `${author} - ${title}.md`;
            let text = `# ${title}\n\n${'This is a readable and conceptually useful paragraph about the subject. '.repeat(420)}`;
            if (id === 'archive-a') {
                text += `\n\n${Array.from(
                    { length: 1600 },
                    (_, index) => `Paragraph ${index + 1} adds distinct evidence about metaphysics and causation.`
                ).join('\n\n')}`;
            }
            if (id === 'measure') text += `\n\nSYNTHETIC-GRID :: �������� :: ////\\\\ :: ...;;;:::###\n`;
            fs.writeFileSync(path.join(input, outputName), text);
            entries.push({
                workId: id, author, title, summaryCz: `${title} summary.`, contentType: 'book',
                relevanceScore: 98, priorityScore: 94, comparativePriority: id.startsWith('archive') ? 90 : 96,
                portfolioRole: 'core', authorRank: 1, creatorKey, creatorWorkCount,
                bundleLikeOrigin: creatorWorkCount > 5, canonicalWorkId: id,
                identityGroupKey: id, editionGroupKey: id, scope: 'standalone_work',
                containsWorkIds: [], containedByWorkIds: [], topicKeys: ['main'],
                standaloneValue: 'high', mustInclude: false, authorSoftMaximum: creatorWorkCount > 5 ? 2 : null,
                outputName
            });
        }
        entries.push({
            workId: 'missing-conversion', author: 'Broken Author', title: 'Unavailable Book',
            contentType: 'book', relevanceScore: 80, priorityScore: 70, comparativePriority: 70,
            portfolioRole: 'supporting', outputName: 'Broken Author - Unavailable Book.md'
        });
        fs.writeFileSync(manifestPath, JSON.stringify({
            corpus: 'TestCorpus',
            totalEligibleWorkCount: entries.length,
            curationAtlasHash: 'atlas',
            curationAtlas: {
                corpus: 'FilosofGPT',
                focus_areas: [{ key: 'main', weight: 5 }],
                must_include_works: [], author_policies: []
            },
            entries
        }));
        const mergeEnvironment = {
            ...process.env,
            CORPUS_NAME: 'TestCorpus',
            MARKDOWN_INPUT_DIR: input,
            MERGED_OUTPUT_DIR: output,
            MERGE_REPORT: reportPath,
            BOOKS_MANIFEST: manifestPath,
            MAX_BOOK_FILES: '2',
            MAX_FILE_SIZE_BYTES: '200000',
            PREFERRED_FILE_SIZE_BYTES: '180000',
            MAX_TOKENS_PER_FILE: '50000'
        };
        const runMerge = () => spawnSync(
            process.execPath,
            [path.join(__dirname, '..', 'src', 'pipeline', 'packaging', 'merge-md.js')],
            {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                env: mergeEnvironment
            }
        );
        const result = runMerge();
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const names = fs.readdirSync(output).sort();
        assert.ok(names.length <= 2);
        assert.ok(names[0].startsWith('01_'));
        assert.ok(names.every(name => /^\d{2}_[a-z0-9_]+\.md$/.test(name) && name.length <= 80));
        assert.ok(names.every(name => !name.includes('TestCorpus')));
        assert.ok(!names.includes('00_Index.md'));
        const first = fs.readFileSync(path.join(output, names[0]), 'utf8');
        assert.match(first, /^# Rozcestník — TestCorpus/);
        assert.match(first, /SYNTHETIC-GRID/);
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        for (const file of report.files) assert.match(first, new RegExp(`\\./${file.fileName.replace('.', '\\.')}#`));
        const linkedNames = new Set([...first.matchAll(/\]\(\.\/([^#)]+\.md)#[^)]+\)/g)].map(match => match[1]));
        assert.deepEqual([...linkedNames].sort(), names);
        assert.equal(report.validation.embeddedIndexTargetsValid, true);
        const measurement = report.selected.find(item => item.id === 'measure');
        assert.ok(measurement);
        assert.equal(measurement.postprocessing.removedCorruptedLines, 0);
        assert.ok(report.files.flatMap(file => file.units).filter(unit => unit.bookId === 'archive-a').length > 1);
        assert.equal(report.validation.tokenCountWithinLimit, true);
        assert.equal(report.selectedBookCount + report.excludedBookCount, entries.length);
        assert.equal(
            report.excluded.find(item => item.id === 'missing-conversion')?.reason,
            'conversion_failed'
        );

        const removedSelection = report.selected[0];
        const removedEntry = entries.find(entry => entry.workId === removedSelection.id);
        assert.ok(removedEntry);
        fs.rmSync(path.join(input, removedEntry.outputName), { force: true });
        const resumed = runMerge();
        assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
        assert.match(resumed.stdout + '\n' + resumed.stderr, /discarding stale cached selection/);
        const resumedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assert.equal(
            resumedReport.excluded.find(item => item.id === removedSelection.id)?.reason,
            'conversion_failed'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

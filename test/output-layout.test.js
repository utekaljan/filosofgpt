'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const fs = require('node:fs');
const {
    config,
    outputRoot,
    resolveProjectPath
} = require('../src/lib/corpus-pipeline');
const { resolveStageScript, stageScripts } = require('../src/lib/pipeline-layout');

test('keeps every generated pipeline directory under output', () => {
    const generatedDirectoryKeys = [
        'stateDir',
        'booksDir',
        'markdownDir',
        'mergedDir',
        'reportsDir'
    ];

    for (const key of generatedDirectoryKeys) {
        const relative = path.relative(outputRoot, resolveProjectPath(config[key]));
        assert.notEqual(relative, '');
        assert.equal(relative === '..' || relative.startsWith(`..${path.sep}`), false, key);
        assert.equal(path.isAbsolute(relative), false, key);
    }
});

test('keeps one canonical operator workflow and one bounded public demo', () => {
    const packageDocument = require('../package.json');
    assert.equal(packageDocument.scripts.ingest, 'node src/cli/run-all.js');
    assert.equal(packageDocument.scripts.master, packageDocument.scripts.ingest);
    assert.equal(
        packageDocument.scripts.demo,
        'node src/cli/ingest.js --input=examples/synthetic --output=output/demo --classifier=metadata --catalog=examples/synthetic-catalog.json'
    );
    assert.equal(packageDocument.scripts.status, undefined);
});

test('resolves every active pipeline stage through the central source layout', () => {
    for (const scriptName of Object.keys(stageScripts)) {
        assert.equal(path.isAbsolute(resolveStageScript(scriptName)), true, scriptName);
    }
});

test('does not recreate historical generated directories in the repository root', () => {
    for (const legacyName of [
        'books',
        'markdown',
        'md_output',
        'merged_md',
        'merged_markdown',
        'pipeline_state',
        'reports'
    ]) {
        assert.equal(fs.existsSync(resolveProjectPath(legacyName)), false, legacyName);
    }
});

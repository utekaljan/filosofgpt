'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

test('checked-in synthetic EPUB runs through the current standalone adapter', () => {
    const epubPath = path.join(projectRoot, 'examples', 'synthetic', 'synthetic-epub-fixture.epub');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(epubPath)).digest('hex');
    assert.equal(digest, '860a7fe6ad9cfb0ebf3b0082a8ee25a5a65ef6b597ae56f82cacb764ac316527');
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-synthetic-demo-'));
    try {
        const result = spawnSync(process.execPath, [
            path.join(projectRoot, 'src', 'cli', 'ingest.js'),
            '--input=examples/synthetic',
            `--output=${outputDir}`,
            '--classifier=metadata',
            '--catalog=examples/synthetic-catalog.json'
        ], {
            cwd: projectRoot,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);

        const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'), 'utf8'));
        assert.equal(catalog.summary.convertedCount, 1);
        assert.deepEqual(catalog.summary.byTarget, {
            FilosofGPT: 1,
            PolyhistorGPT: 0,
            null: 0,
            unclassified: 0
        });
        assert.equal(catalog.works[0].author, 'Fixture Author');
        assert.equal(catalog.works[0].title, 'Synthetic EPUB Fixture');
        assert.equal(catalog.works[0].sourceName, 'synthetic-epub-fixture.epub');
        assert.equal(fs.readdirSync(path.join(outputDir, 'ready', 'FilosofGPT')).length, 1);
        const markdown = fs.readFileSync(
            path.join(outputDir, 'markdown', 'synthetic-epub-fixture.md'),
            'utf8'
        );
        assert.match(markdown, /^# Synthetic EPUB Fixture$/m);
        assert.match(markdown, /^## Author: Fixture Author$/m);
        assert.match(markdown, /Fixture Chapter/);
        assert.match(markdown, /synthetic conversion marker/);
        assert.match(markdown, /^\* invented metadata;$/m);
        assert.match(markdown, /^\* invented prose;$/m);
        assert.match(markdown, /^\* local and deterministic conversion\.$/m);

        const report = JSON.parse(
            fs.readFileSync(path.join(outputDir, 'reports', 'conversion.json'), 'utf8')
        );
        assert.equal(report[0].conversionVersion, 1);
        assert.equal(report[0].sectionCount, 1);
        assert.equal(report[0].sourceType, 'epub');
        assert.deepEqual(report[0].converter, {
            name: 'epub2md',
            version: '1.6.3',
            repository: 'https://github.com/uxiew/epub2MD',
            commit: 'f04a454fab4495298f33a4406fb2f2d7380a7e15',
            license: 'MIT'
        });
    } finally {
        fs.rmSync(outputDir, { recursive: true, force: true });
    }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    conversionStackId,
    conversionVersion,
    converters,
    doclingEnvironmentDir
} = require('../src/lib/converter-stack');

const projectRoot = path.join(__dirname, '..');

test('pins the public converter stack and keeps upstream source outside the repository', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    const requirements = fs.readFileSync(
        path.join(projectRoot, 'tools', 'converters', 'requirements.txt'),
        'utf8'
    );
    const notices = fs.readFileSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');

    assert.equal(packageJson.dependencies.epub2md, converters.epub.version);
    assert.equal(packageJson.dependencies['pdfjs-dist'], '6.2.108');
    assert.equal(packageLock.packages[''].dependencies.epub2md, converters.epub.version);
    assert.equal(packageLock.packages[''].dependencies['pdfjs-dist'], '6.2.108');
    assert.equal(packageLock.packages['node_modules/epub2md'].license, 'MIT');
    assert.equal(packageLock.packages['node_modules/pdfjs-dist'].license, 'Apache-2.0');
    assert.match(requirements, new RegExp(`docling\\.git@${converters.pdf.commit}`));
    assert.match(requirements, /^docling-slim\[convert-core,format-pdf,models-local\]/m);
    assert.match(notices, new RegExp(converters.epub.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(notices, new RegExp(converters.pdf.repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(notices, /github\.com\/mozilla\/pdf\.js\/tree\/v6\.2\.108/);
    assert.match(notices, /0365cbde028bd92e58f2dab1bb70cd30ac7acfd7/);
    assert.equal(converters.epub.license, 'MIT');
    assert.equal(converters.pdf.license, 'MIT');
    assert.equal(converters.pdf.distribution, 'docling-slim');
    assert.equal(conversionVersion, 1);
    assert.equal(conversionStackId, 'epub:epub2md@1.6.3|pdf:docling@2.123.1');
    assert.ok(doclingEnvironmentDir().startsWith(path.join(projectRoot, 'output', 'tools')));
    assert.equal(fs.existsSync(path.join(projectRoot, 'vendor', 'epub-to-markdown')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, 'vendor', 'pdf-to-markdown')), false);
});

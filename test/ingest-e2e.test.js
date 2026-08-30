'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const { defaultDoclingPythonPath } = require('../src/lib/converter-stack');

const projectRoot = path.resolve(__dirname, '..');

function commandExists(command) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    return !result.error;
}

function escapePdfText(text) {
    return text.replace(/([\\()])/g, '\\$1');
}

function createPdf(filePath, text) {
    const stream = `BT\n/F1 16 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
    ];
    let body = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(body));
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    fs.writeFileSync(filePath, body, 'binary');
}

function createEpub(filePath, workspace) {
    const epubRoot = path.join(workspace, 'epub-source');
    fs.mkdirSync(path.join(epubRoot, 'META-INF'), { recursive: true });
    fs.mkdirSync(path.join(epubRoot, 'OEBPS'), { recursive: true });
    fs.writeFileSync(path.join(epubRoot, 'mimetype'), 'application/epub+zip', 'utf8');
    fs.writeFileSync(path.join(epubRoot, 'META-INF', 'container.xml'), [
        '<?xml version="1.0"?>',
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
        '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>',
        '</container>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(epubRoot, 'OEBPS', 'content.opf'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">',
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        '    <dc:title>Public EPUB Smoke Document</dc:title>',
        '    <dc:creator>Example Author</dc:creator>',
        '    <dc:identifier id="bookid">public-smoke</dc:identifier>',
        '    <dc:language>en</dc:language>',
        '  </metadata>',
        '  <manifest>',
        '    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>',
        '    <item id="style" href="style.css" media-type="text/css"/>',
        '  </manifest>',
        '  <spine><itemref idref="chapter"/></spine>',
        '</package>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(epubRoot, 'OEBPS', 'chapter.xhtml'), [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>',
        '<h1>Introduction</h1>',
        '<p>This fully synthetic fixture verifies that EPUB text becomes readable Markdown without any private corpus material.</p>',
        '<p>Its second paragraph provides enough ordinary prose for the converter quality checks and deterministic routing test.</p>',
        '</body></html>'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(epubRoot, 'OEBPS', 'style.css'), 'body { font-family: serif; }\n', 'utf8');

    let result = spawnSync('zip', ['-X0', filePath, 'mimetype'], { cwd: epubRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync('zip', ['-Xr9D', filePath, 'META-INF', 'OEBPS'], { cwd: epubRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
}

function outputSnapshot(directoryPath) {
    const files = [];
    function visit(currentPath) {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolutePath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) visit(absolutePath);
            else if (entry.isFile()) files.push({
                path: path.relative(directoryPath, absolutePath),
                sha256: crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
            });
        }
    }
    visit(directoryPath);
    return files;
}

test('ingests local EPUB and optionally a configured Docling PDF, then resumes deterministically', {
    skip: !commandExists('zip'),
    timeout: 180_000
}, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'filosofgpt-ingest-'));
    try {
        const inputDir = path.join(workspace, 'input');
        const outputDir = path.join(workspace, 'output');
        const hasDocling = fs.existsSync(defaultDoclingPythonPath());
        fs.mkdirSync(inputDir, { recursive: true });
        if (hasDocling) {
            createPdf(
                path.join(inputDir, 'Public PDF Smoke Document.pdf'),
                'This synthetic PDF verifies local conversion into readable Markdown text without any private source material.'
            );
        }
        createEpub(path.join(inputDir, 'Public EPUB Smoke Document.epub'), workspace);
        const catalogPath = path.join(inputDir, 'catalog.json');
        const works = [
            {
                source: 'Public EPUB Smoke Document.epub',
                author: 'Example Author',
                title: 'Public EPUB Smoke Document',
                summaryCz: 'Syntetický testovací dokument.',
                target: 'PolyhistorGPT',
                confidence: 1,
                reasonCz: 'Testovací metadata.'
            }
        ];
        if (hasDocling) {
            works.unshift({
                source: 'Public PDF Smoke Document.pdf',
                author: 'Example Author',
                title: 'Public PDF Smoke Document',
                summaryCz: 'Syntetický testovací dokument.',
                target: 'FilosofGPT',
                confidence: 1,
                reasonCz: 'Testovací metadata.'
            });
        }
        fs.writeFileSync(catalogPath, `${JSON.stringify({
            version: 1,
            works
        }, null, 2)}\n`, 'utf8');

        const ingestArguments = [
            'src/cli/ingest.js',
            `--input=${inputDir}`,
            `--output=${outputDir}`,
            '--classifier=metadata',
            `--catalog=${catalogPath}`
        ];
        let result = spawnSync(process.execPath, ingestArguments, { cwd: projectRoot, encoding: 'utf8' });

        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const firstSnapshot = outputSnapshot(outputDir);
        result = spawnSync(process.execPath, ingestArguments, { cwd: projectRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(outputSnapshot(outputDir), firstSnapshot);
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['catalog.json', 'markdown', 'ready', 'reports']);
        const epubMarkdown = fs.readFileSync(path.join(outputDir, 'markdown', 'Public EPUB Smoke Document.md'), 'utf8');
        assert.match(epubMarkdown, /EPUB text becomes readable Markdown/i);
        assert.ok(fs.existsSync(path.join(outputDir, 'ready', 'PolyhistorGPT', 'Public EPUB Smoke Document.md')));
        if (hasDocling) {
            const pdfMarkdown = fs.readFileSync(path.join(outputDir, 'markdown', 'Public PDF Smoke Document.md'), 'utf8');
            assert.match(pdfMarkdown, /synthetic PDF verifies local conversion/i);
            assert.ok(fs.existsSync(path.join(outputDir, 'ready', 'FilosofGPT', 'Public PDF Smoke Document.md')));
        }

        const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'), 'utf8'));
        assert.equal(catalog.summary.convertedCount, works.length);
        assert.equal(catalog.summary.classifiedCount, works.length);
        assert.deepEqual(catalog.summary.byTarget, {
            FilosofGPT: hasDocling ? 1 : 0,
            PolyhistorGPT: 1,
            null: 0,
            unclassified: 0
        });
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

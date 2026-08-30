'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const converterPath = path.join(projectRoot, 'src', 'pipeline', 'conversion', 'convert-books.js');

function converterEnvironment(root, overrides = {}) {
    return {
        ...process.env,
        BOOKS_INPUT_DIR: path.join(root, 'input'),
        MARKDOWN_OUTPUT_DIR: path.join(root, 'markdown'),
        CONVERSION_TEMP_DIR: path.join(root, 'temp'),
        CONVERSION_ERROR_LOG: path.join(root, 'reports', 'errors.log'),
        CONVERSION_REPORT: path.join(root, 'reports', 'conversion.json'),
        CONVERSION_CLEAN: '0',
        CONVERSION_RESUME: '1',
        ...overrides
    };
}

function runConverter(root, overrides = {}) {
    return spawnSync(process.execPath, [converterPath], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: converterEnvironment(root, overrides),
        timeout: 10000
    });
}

test('reuses only a matching completed conversion checkpoint', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-conversion-resume-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        const sourcePath = path.join(inputDir, 'Stable Source.md');
        fs.writeFileSync(sourcePath, '# Stable Source\n\nOriginal checkpoint content.\n', 'utf8');

        let result = runConverter(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout + '\n' + result.stderr, /REUSED/);

        const reportPath = path.join(root, 'reports', 'conversion.json');
        const legacyReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        legacyReport[0].conversionVersion = 0;
        fs.writeFileSync(reportPath, `${JSON.stringify(legacyReport, null, 2)}\n`, 'utf8');
        result = runConverter(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout + '\n' + result.stderr, /REUSED/);

        result = runConverter(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout + '\n' + result.stderr, /REUSED/);

        fs.appendFileSync(path.join(root, 'markdown', 'Stable Source.md'), 'invalidates output size\n', 'utf8');
        result = runConverter(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout + '\n' + result.stderr, /REUSED/);

        fs.appendFileSync(sourcePath, '\nA source-size change invalidates the checkpoint.\n', 'utf8');
        result = runConverter(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stdout + '\n' + result.stderr, /REUSED/);

        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assert.equal(report[0].conversionVersion, 1);
        assert.equal(report[0].conversionStackId, 'epub:epub2md@1.6.3|pdf:docling@2.123.1');
        assert.equal(report[0].metrics.bytes, fs.statSync(path.join(root, 'markdown', 'Stable Source.md')).size);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed selected EPUB does not fall back to a same-basename PDF', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-no-fallback-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'One Work.epub'), 'not an epub', 'utf8');
        fs.writeFileSync(path.join(inputDir, 'One Work.pdf'), '%PDF-1.4\nnot needed\n', 'utf8');
        const fakePython = path.join(root, 'unused-docling-python');
        fs.writeFileSync(fakePython, '', 'utf8');

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(fs.existsSync(path.join(root, 'markdown', 'One Work.md')), false);

        const report = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'conversion.json'), 'utf8'));
        const epub = report.find(entry => entry.sourceType === 'epub');
        const pdf = report.find(entry => entry.sourceType === 'pdf');
        assert.equal(epub.failed, true);
        assert.equal(pdf.skipped, true);
        assert.equal(
            pdf.reason,
            'Higher-priority source with the same base name was already selected; fallback is disabled.'
        );

        const retry = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(retry.status, 0, retry.stderr || retry.stdout);
        assert.match(retry.stdout + '\n' + retry.stderr, /Processing EPUB:/);
        assert.doesNotMatch(retry.stdout + '\n' + retry.stderr, /REUSED .*One Work/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a reused higher-priority source still forces a lower-priority source to skip', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-no-fallback-reuse-'));
    try {
        const inputDir = path.join(root, 'input');
        const markdownDir = path.join(root, 'markdown');
        const reportsDir = path.join(root, 'reports');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.mkdirSync(markdownDir, { recursive: true });
        fs.mkdirSync(reportsDir, { recursive: true });
        const epubPath = path.join(inputDir, 'One Work.epub');
        const pdfPath = path.join(inputDir, 'One Work.pdf');
        fs.writeFileSync(epubPath, 'checkpoint-only epub', 'utf8');
        fs.writeFileSync(pdfPath, '%PDF-1.4\ncheckpoint-only pdf\n', 'utf8');
        const outputPath = path.join(markdownDir, 'One Work.md');
        fs.writeFileSync(outputPath, '# One Work\n\nExisting higher-priority converted content.\n', 'utf8');
        const outputBytes = fs.statSync(outputPath).size;
        const report = [
            {
                baseName: 'One Work', sourceType: 'epub', sourcePath: epubPath,
                conversionVersion: 1,
                conversionStackId: 'epub:epub2md@1.6.3|pdf:docling@2.123.1',
                sourceSize: fs.statSync(epubPath).size,
                sourceMtimeMs: fs.statSync(epubPath).mtimeMs,
                metrics: { bytes: outputBytes }
            },
            {
                baseName: 'One Work', sourceType: 'pdf', sourcePath: pdfPath,
                conversionVersion: 1,
                conversionStackId: 'epub:epub2md@1.6.3|pdf:docling@2.123.1',
                sourceSize: fs.statSync(pdfPath).size,
                sourceMtimeMs: fs.statSync(pdfPath).mtimeMs,
                metrics: { bytes: outputBytes }
            }
        ];
        fs.writeFileSync(
            path.join(reportsDir, 'conversion.json'),
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8'
        );
        const fakePython = path.join(root, 'unused-docling-python');
        fs.writeFileSync(fakePython, '', 'utf8');

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout + '\n' + result.stderr, /REUSED .*One Work\.epub/);
        assert.match(result.stdout + '\n' + result.stderr, /SKIPPED .*One Work\.pdf/);
        const resumedReport = JSON.parse(fs.readFileSync(path.join(reportsDir, 'conversion.json'), 'utf8'));
        assert.equal(resumedReport.find(entry => entry.sourceType === 'pdf').skipped, true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('missing Docling is fatal before existing conversion output is touched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-preflight-'));
    try {
        const inputDir = path.join(root, 'input');
        const markdownDir = path.join(root, 'markdown');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.mkdirSync(markdownDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Needs Docling.pdf'), '%PDF-1.4\n', 'utf8');
        const sentinelPath = path.join(markdownDir, 'existing.md');
        fs.writeFileSync(sentinelPath, 'preserve me\n', 'utf8');

        const result = runConverter(root, {
            DOCLING_PYTHON: path.join(root, 'missing-python')
        });
        assert.notEqual(result.status, 0);
        assert.match(
            result.stdout + '\n' + result.stderr,
            /Run npm run setup:converters or set DOCLING_PYTHON/
        );
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'preserve me\n');
        assert.equal(fs.existsSync(path.join(root, 'reports', 'conversion.json')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an existing but non-executable Docling command fails globally without hanging', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-unusable-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Needs Worker.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'non-executable-python');
        fs.writeFileSync(fakePython, '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o600 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(
            result.stdout + '\n' + result.stderr,
            /Unable to (?:start|send a request to|communicate with) the Docling worker|EACCES/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a nonzero worker exit after its last response remains globally fatal', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-exit-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Worker Exit.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'fake-docling-python');
        fs.writeFileSync(fakePython, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\\n');
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline));
    const markdown = '## Page 1\\n\\nOne two three four five six seven eight nine ten eleven twelve.\\n';
    fs.mkdirSync(path.dirname(request.output), { recursive: true });
    fs.writeFileSync(request.output, markdown, 'utf8');
    process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        sourcePageCount: 1,
        convertedPageCount: 1,
        elapsedSeconds: 0.01,
        bytes: Buffer.byteLength(markdown),
        doclingVersion: '2.123.1'
    }) + '\\n', () => process.exit(7));
});
`, { encoding: 'utf8', mode: 0o700 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(
            result.stdout + '\n' + result.stderr,
            /Docling worker stopped unexpectedly \(exit 7\)|Unable to (?:send a request to|communicate with) the Docling worker/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a worker self-exiting zero without a shutdown acknowledgement is globally fatal', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-early-zero-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Early Zero.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'early-zero-docling-python');
        fs.writeFileSync(fakePython, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\\n');
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline));
    const markdown = '## Page 1\\n\\nOne two three four five six seven eight nine ten eleven twelve.\\n';
    fs.mkdirSync(path.dirname(request.output), { recursive: true });
    fs.writeFileSync(request.output, markdown, 'utf8');
    process.stdout.write(JSON.stringify({
        id: request.id,
        ok: true,
        sourcePageCount: 1,
        convertedPageCount: 1,
        elapsedSeconds: 0.01,
        bytes: Buffer.byteLength(markdown),
        doclingVersion: '2.123.1'
    }) + '\\n', () => process.exit(0));
});
`, { encoding: 'utf8', mode: 0o700 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(
            result.stdout + '\n' + result.stderr,
            /Docling worker stopped unexpectedly \(exit 0\)|Unable to (?:send a request to|communicate with) the Docling worker/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a worker shutdown acknowledgement closes a successful PDF session cleanly', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-shutdown-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Clean Shutdown.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'clean-shutdown-docling-python');
        fs.writeFileSync(fakePython, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline = buffer.indexOf('\\n');
    while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.command === 'shutdown') {
            process.stdout.write(JSON.stringify({
                id: request.id,
                ok: true,
                shutdown: true,
                doclingVersion: '2.123.1'
            }) + '\\n', () => process.exit(0));
        } else {
            const markdown = '## Page 1\\n\\nOne two three four five six seven eight nine ten eleven twelve.\\n';
            fs.mkdirSync(path.dirname(request.output), { recursive: true });
            fs.writeFileSync(request.output, markdown, 'utf8');
            process.stdout.write(JSON.stringify({
                id: request.id,
                ok: true,
                sourcePageCount: 1,
                convertedPageCount: 1,
                elapsedSeconds: 0.01,
                bytes: Buffer.byteLength(markdown),
                doclingVersion: '2.123.1'
            }) + '\\n');
        }
        newline = buffer.indexOf('\\n');
    }
});
`, { encoding: 'utf8', mode: 0o700 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(fs.existsSync(path.join(root, 'markdown', 'Clean Shutdown.md')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a worker reporting the wrong Docling version is globally fatal', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-version-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Wrong Version.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'wrong-version-docling-python');
        fs.writeFileSync(fakePython, `#!/usr/bin/env node
'use strict';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\\n');
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline));
    process.stdout.write(JSON.stringify({
        id: request.id,
        ok: false,
        doclingVersion: '2.123.0',
        error: 'version test'
    }) + '\\n');
});
`, { encoding: 'utf8', mode: 0o700 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + '\n' + result.stderr, /Expected Docling 2\.123\.1, worker reported 2\.123\.0/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a worker response with an unknown request id is globally fatal', {
    skip: process.platform === 'win32'
}, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filosof-docling-request-id-'));
    try {
        const inputDir = path.join(root, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, 'Wrong Id.pdf'), '%PDF-1.4\n', 'utf8');
        const fakePython = path.join(root, 'wrong-id-docling-python');
        fs.writeFileSync(fakePython, `#!/usr/bin/env node
'use strict';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\\n');
    if (newline === -1) return;
    const request = JSON.parse(buffer.slice(0, newline));
    process.stdout.write(JSON.stringify({
        id: request.id + 1,
        ok: false,
        doclingVersion: '2.123.1',
        error: 'request id test'
    }) + '\\n');
});
`, { encoding: 'utf8', mode: 0o700 });

        const result = runConverter(root, { DOCLING_PYTHON: fakePython });
        assert.equal(result.error, undefined, result.error?.message);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + '\n' + result.stderr, /unknown request id/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

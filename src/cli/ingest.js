'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    ensureDirectory,
    projectRoot,
    stableHash,
    writeJsonAtomic
} = require('../lib/corpus-pipeline');
const { requireDoclingPythonPath } = require('../lib/converter-stack');
const { resolveStageScript } = require('../lib/pipeline-layout');

const supportedExtensions = new Set(['.md', '.epub', '.pdf']);
const allowedClassifiers = new Set(['none', 'metadata', 'openai']);
const allowedTargets = new Set(['FilosofGPT', 'PolyhistorGPT', 'null']);

function argumentValue(name, fallback = null) {
    const prefix = `--${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function resolveCliPath(value) {
    return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

const inputDir = resolveCliPath(argumentValue('input', 'input'));
const outputDir = resolveCliPath(argumentValue('output', 'output'));
const classifier = argumentValue('classifier', 'none');
const metadataPath = resolveCliPath(argumentValue('catalog', path.join(inputDir, 'catalog.json')));
const model = argumentValue('model', process.env.OPENAI_MODEL || 'gpt-5.4-mini');
const preflightOnly = process.argv.includes('--preflight');

function relativeForDisplay(filePath) {
    const relative = path.relative(projectRoot, filePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function listInputFiles() {
    if (!fs.existsSync(inputDir)) return [];
    return fs.readdirSync(inputDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
        .map(entry => ({
            name: entry.name,
            path: path.join(inputDir, entry.name),
            extension: path.extname(entry.name).toLowerCase()
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

function preflight() {
    const errors = [];
    const warnings = [];
    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
    const files = listInputFiles();

    if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
        errors.push(`Node.js 22.13 or newer (Node 24 recommended) is required; found ${process.versions.node}.`);
    }
    if (!allowedClassifiers.has(classifier)) {
        errors.push(`Unknown classifier "${classifier}". Use none, metadata, or openai.`);
    }
    if (!fs.existsSync(inputDir)) {
        errors.push(`Input directory does not exist: ${relativeForDisplay(inputDir)}.`);
    } else if (!fs.statSync(inputDir).isDirectory()) {
        errors.push(`Input path is not a directory: ${relativeForDisplay(inputDir)}.`);
    }

    const unzipTool = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (unzipTool.error?.code === 'ENOENT' && files.some(file => file.extension === '.epub')) {
        errors.push('EPUB inspection requires the system unzip command.');
    } else if (unzipTool.error?.code === 'ENOENT') {
        warnings.push('EPUB inspection requires unzip. Markdown and PDF input can still be processed.');
    }
    if (files.some(file => file.extension === '.pdf')) {
        try {
            requireDoclingPythonPath();
        } catch (error) {
            errors.push(error.message);
        }
    }

    if (classifier === 'metadata' && !fs.existsSync(metadataPath)) {
        errors.push(`Metadata classifier requires ${relativeForDisplay(metadataPath)}.`);
    }
    if (classifier === 'openai' && !process.env.OPENAI_API_KEY) {
        errors.push('OpenAI classification requires OPENAI_API_KEY. Offline conversion does not.');
    }

    if (files.length === 0) warnings.push('No .md, .epub, or .pdf files found directly inside the input directory.');

    return { errors, warnings, files };
}

function printPreflight(result) {
    console.log(`Input: ${relativeForDisplay(inputDir)}`);
    console.log(`Output: ${relativeForDisplay(outputDir)}`);
    console.log(`Classifier: ${classifier}${classifier === 'openai' ? ` (${model})` : ''}`);
    console.log(`Supported files: ${result.files.length}`);
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
    for (const error of result.errors) console.error(`Error: ${error}`);
}

function assertSafeOutputDirectory() {
    const resolvedOutput = path.resolve(outputDir);
    const resolvedInput = path.resolve(inputDir);
    const filesystemRoot = path.parse(resolvedOutput).root;
    if (
        resolvedOutput === filesystemRoot ||
        resolvedOutput === path.resolve(projectRoot) ||
        resolvedOutput === resolvedInput ||
        resolvedInput.startsWith(`${resolvedOutput}${path.sep}`)
    ) {
        throw new Error(`Refusing to clean unsafe output directory: ${relativeForDisplay(resolvedOutput)}.`);
    }
}

function prepareOutputDirectory() {
    assertSafeOutputDirectory();
    ensureDirectory(outputDir);
}

function runConversion() {
    const markdownDir = path.join(outputDir, 'markdown');
    const reportsDir = path.join(outputDir, 'reports');
    const result = spawnSync(process.execPath, [resolveStageScript('convert-books.js')], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
            ...process.env,
            BOOKS_INPUT_DIR: inputDir,
            MARKDOWN_OUTPUT_DIR: markdownDir,
            CONVERSION_TEMP_DIR: path.join(outputDir, 'temp', 'conversion'),
            CONVERSION_ERROR_LOG: path.join(reportsDir, 'conversion-errors.log'),
            CONVERSION_REPORT: path.join(reportsDir, 'conversion.json'),
            CONVERSION_CLEAN: '0',
            CONVERSION_RESUME: '1'
        }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Conversion failed with exit ${result.status ?? 1}. See ${relativeForDisplay(path.join(reportsDir, 'conversion-errors.log'))}.`);
    }
    return { markdownDir, reportsDir };
}

function loadConversionRecords(reportsDir) {
    const reportPath = path.join(reportsDir, 'conversion.json');
    if (!fs.existsSync(reportPath)) throw new Error(`Missing conversion report: ${relativeForDisplay(reportPath)}.`);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return report
        .filter(entry => !entry.skipped && entry.metrics?.bytes > 0)
        .map(entry => ({
            sourceName: path.basename(entry.sourcePath),
            sourceType: entry.sourceType,
            markdownName: `${entry.baseName}.md`,
            metrics: entry.metrics
        }));
}

function loadMetadataDefinitions() {
    const document = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (document.version !== 1 || !Array.isArray(document.works)) {
        throw new Error(`${relativeForDisplay(metadataPath)} must contain {"version":1,"works":[...]}.`);
    }
    return document.works;
}

function normalizeClassification(classification, sourceName, evidence) {
    if (!allowedTargets.has(classification.target)) {
        throw new Error(`${sourceName}: target must be FilosofGPT, PolyhistorGPT, or null.`);
    }
    const confidence = Number(classification.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`${sourceName}: confidence must be between 0 and 1.`);
    }
    return {
        author: String(classification.author || '').trim(),
        title: String(classification.title || path.basename(sourceName, path.extname(sourceName))).trim(),
        summaryCz: String(classification.summaryCz || '').trim(),
        target: classification.target,
        confidence,
        reasonCz: String(classification.reasonCz || '').trim(),
        evidence
    };
}

function classifyFromMetadata(record, definitions) {
    const matches = definitions.filter(definition => definition.source === record.sourceName);
    if (matches.length !== 1) {
        throw new Error(`${record.sourceName}: expected exactly one matching metadata record, found ${matches.length}.`);
    }
    return normalizeClassification(matches[0], record.sourceName, 'user_metadata');
}

function textSample(markdownPath) {
    const text = fs.readFileSync(markdownPath, 'utf8');
    const head = text.slice(0, 14000);
    const tail = text.length > 18000 ? text.slice(-4000) : '';
    return `${head}${tail ? `\n\n[END SAMPLE]\n\n${tail}` : ''}`;
}

function responseOutputText(response) {
    if (typeof response.output_text === 'string' && response.output_text) return response.output_text;
    for (const item of response.output || []) {
        for (const content of item.content || []) {
            if (content.type === 'output_text' && content.text) return content.text;
        }
    }
    throw new Error('OpenAI response did not contain output text.');
}

async function classifyWithOpenAI(record, markdownDir) {
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            store: false,
            instructions: [
                'Classify one book for a public two-corpus knowledge pipeline.',
                'FilosofGPT covers philosophy, mind, consciousness, neuroscience, physics, AI, and closely related foundations.',
                'PolyhistorGPT covers history, economics, geopolitics, political philosophy, institutions, and social history.',
                'Use target null for material outside both scopes. Political philosophy belongs to PolyhistorGPT when scopes overlap.',
                'Infer only from the supplied filename and bounded text sample. Write concise Czech summary and reason.'
            ].join(' '),
            input: JSON.stringify({
                filename: record.sourceName,
                textSample: textSample(path.join(markdownDir, record.markdownName))
            }),
            text: {
                format: {
                    type: 'json_schema',
                    name: 'book_classification',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            author: { type: 'string' },
                            title: { type: 'string' },
                            summaryCz: { type: 'string' },
                            target: { type: 'string', enum: ['FilosofGPT', 'PolyhistorGPT', 'null'] },
                            confidence: { type: 'number', minimum: 0, maximum: 1 },
                            reasonCz: { type: 'string' }
                        },
                        required: ['author', 'title', 'summaryCz', 'target', 'confidence', 'reasonCz']
                    }
                }
            }
        })
    });
    const body = await response.json();
    if (!response.ok) {
        throw new Error(`OpenAI classification failed (${response.status}): ${body.error?.message || 'unknown error'}`);
    }
    return normalizeClassification(JSON.parse(responseOutputText(body)), record.sourceName, `openai:${model}`);
}

function destinationGroup(target) {
    return target === 'null' ? 'rejected' : target;
}

function cleanReadyDirectory(readyDir) {
    if (fs.existsSync(readyDir)) fs.rmSync(readyDir, { recursive: true, force: true });
}

async function buildCatalog(records, markdownDir) {
    const definitions = classifier === 'metadata' ? loadMetadataDefinitions() : [];
    const readyDir = path.join(outputDir, 'ready');
    cleanReadyDirectory(readyDir);
    const works = [];

    for (const record of records) {
        let classification;
        if (classifier === 'metadata') {
            classification = classifyFromMetadata(record, definitions);
        } else if (classifier === 'openai') {
            classification = await classifyWithOpenAI(record, markdownDir);
        } else {
            classification = {
                author: '',
                title: path.basename(record.sourceName, path.extname(record.sourceName)),
                summaryCz: '',
                target: 'unclassified',
                confidence: null,
                reasonCz: 'Offline conversion completed; semantic classification was not requested.',
                evidence: 'none'
            };
        }

        const group = classification.target === 'unclassified'
            ? 'unclassified'
            : destinationGroup(classification.target);
        const groupDir = path.join(readyDir, group);
        ensureDirectory(groupDir);
        fs.copyFileSync(path.join(markdownDir, record.markdownName), path.join(groupDir, record.markdownName));
        works.push({ ...record, ...classification, readyGroup: group });
    }

    const summary = {
        classifier,
        model: classifier === 'openai' ? model : null,
        inputFingerprint: stableHash(records.map(record => ({
            sourceName: record.sourceName,
            sourceType: record.sourceType,
            markdownName: record.markdownName,
            bytes: record.metrics.bytes,
            tokenCounts: record.metrics.tokenCounts
        }))),
        convertedCount: records.length,
        classifiedCount: works.filter(work => allowedTargets.has(work.target)).length,
        unclassifiedCount: works.filter(work => work.target === 'unclassified').length,
        byTarget: Object.fromEntries(['FilosofGPT', 'PolyhistorGPT', 'null', 'unclassified'].map(target => [
            target,
            works.filter(work => work.target === target).length
        ]))
    };
    writeJsonAtomic(path.join(outputDir, 'catalog.json'), { version: 1, summary, works });
    return summary;
}

async function main() {
    const result = preflight();
    printPreflight(result);
    if (result.errors.length > 0) process.exitCode = 1;
    if (preflightOnly || result.errors.length > 0) return;
    if (result.files.length === 0) {
        throw new Error('Nothing to ingest. Add .md, .epub, or .pdf files to the input directory.');
    }

    prepareOutputDirectory();
    const { markdownDir, reportsDir } = runConversion();
    const records = loadConversionRecords(reportsDir);
    const summary = await buildCatalog(records, markdownDir);
    fs.rmSync(path.join(outputDir, 'temp'), { recursive: true, force: true });
    fs.rmSync(path.join(outputDir, '.DS_Store'), { force: true });
    console.log(`\nIngest completed: ${summary.convertedCount} converted, ${summary.classifiedCount} classified, ${summary.unclassifiedCount} unclassified.`);
    console.log(`Markdown: ${relativeForDisplay(markdownDir)}`);
    console.log(`Prepared copies: ${relativeForDisplay(path.join(outputDir, 'ready'))}`);
    console.log(`Catalog: ${relativeForDisplay(path.join(outputDir, 'catalog.json'))}`);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});

module.exports = {
    normalizeClassification,
    responseOutputText
};

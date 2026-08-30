'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { config, projectRoot, resolveProjectPath } = require('../lib/corpus-pipeline');
const { requireDoclingPythonPath } = require('../lib/converter-stack');

const inputDir = resolveProjectPath(config.sourceDir);
const supported = new Set(config.supportedExtensions);

function command(command, args) {
    return spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' });
}

function nodeSupportsPdfJs() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 13);
}

function listSupportedFiles(directoryPath, rootPath = directoryPath) {
    const files = [];
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSupportedFiles(absolutePath, rootPath));
        } else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) {
            files.push(path.relative(rootPath, absolutePath));
        }
    }
    return files;
}

function main() {
    const errors = [];
    const warnings = [];
    if (!nodeSupportsPdfJs()) {
        errors.push(`Node.js 22.13+ (Node 24 recommended) is required; found ${process.versions.node}.`);
    }
    if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
        errors.push(`Missing input directory: ${inputDir}`);
    }
    const files = fs.existsSync(inputDir) && fs.statSync(inputDir).isDirectory()
        ? listSupportedFiles(inputDir)
        : [];
    if (!files.length) warnings.push('No .md, .epub, or .pdf input books were found.');

    const codexVersion = command('codex', ['--version']);
    if (codexVersion.error || codexVersion.status !== 0) errors.push('Codex CLI is missing or cannot start.');
    const codexLogin = command('codex', ['login', 'status']);
    if (codexLogin.error || codexLogin.status !== 0) errors.push('Codex CLI is not logged in; run `codex login`.');
    if (files.some(name => name.toLowerCase().endsWith('.pdf'))) {
        try {
            requireDoclingPythonPath();
        } catch (error) {
            errors.push(error.message);
        }
    }
    if (files.some(name => name.toLowerCase().endsWith('.epub'))) {
        const unzip = command('unzip', ['-v']);
        if (unzip.error?.code === 'ENOENT') errors.push('EPUB input requires unzip.');
    }

    console.log(`Input books: ${files.length}`);
    console.log(`Codex CLI: ${codexVersion.status === 0 ? codexVersion.stdout.trim() || 'available' : 'unavailable'}`);
    console.log(`Codex login: ${codexLogin.status === 0 ? 'available' : 'unavailable'}`);
    warnings.forEach(message => console.warn(`Warning: ${message}`));
    errors.forEach(message => console.error(`Error: ${message}`));
    if (errors.length) process.exitCode = 1;
}

main();

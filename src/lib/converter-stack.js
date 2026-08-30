'use strict';

const fs = require('fs');
const path = require('path');
const { projectRoot } = require('./corpus-pipeline');

const conversionVersion = 1;

const converters = Object.freeze({
    epub: Object.freeze({
        name: 'epub2md',
        version: '1.6.3',
        repository: 'https://github.com/uxiew/epub2MD',
        commit: 'f04a454fab4495298f33a4406fb2f2d7380a7e15',
        license: 'MIT'
    }),
    pdf: Object.freeze({
        name: 'docling',
        distribution: 'docling-slim',
        version: '2.123.1',
        repository: 'https://github.com/docling-project/docling',
        commit: 'd745e9708c1aa207cf4622fb21fdde68267f64ab',
        license: 'MIT'
    })
});

const conversionStackId = [
    `epub:${converters.epub.name}@${converters.epub.version}`,
    `pdf:${converters.pdf.name}@${converters.pdf.version}`
].join('|');

function doclingEnvironmentDir() {
    return path.join(projectRoot, 'output', 'tools', `docling-${converters.pdf.version}`);
}

function defaultDoclingPythonPath() {
    return process.platform === 'win32'
        ? path.join(doclingEnvironmentDir(), 'Scripts', 'python.exe')
        : path.join(doclingEnvironmentDir(), 'bin', 'python');
}

function resolveDoclingPythonPath() {
    const configured = process.env.DOCLING_PYTHON;
    if (!configured) return defaultDoclingPythonPath();
    return path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
}

function requireDoclingPythonPath() {
    const pythonPath = resolveDoclingPythonPath();
    if (!fs.existsSync(pythonPath)) {
        throw new Error(
            `Docling ${converters.pdf.version} is not installed at ${pythonPath}. ` +
            'Run npm run setup:converters or set DOCLING_PYTHON to a compatible environment.'
        );
    }
    return pythonPath;
}

module.exports = {
    conversionStackId,
    conversionVersion,
    converters,
    defaultDoclingPythonPath,
    doclingEnvironmentDir,
    requireDoclingPythonPath,
    resolveDoclingPythonPath
};

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectRoot } = require('../lib/corpus-pipeline');
const {
    converters,
    defaultDoclingPythonPath,
    doclingEnvironmentDir
} = require('../lib/converter-stack');
const { progressLog } = require('../lib/progress');

const requirementsPath = path.join(projectRoot, 'tools', 'converters', 'requirements.txt');
const environmentDir = doclingEnvironmentDir();
const toolsDir = path.join(projectRoot, 'output', 'tools');
const pipCacheDir = path.join(toolsDir, 'cache', 'pip');
const setupTempDir = path.join(toolsDir, 'temp', 'setup');
const clean = process.argv.includes('--clean');

function run(command, args, options = {}) {
    progressLog('setup:converters', `${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        encoding: options.capture ? 'utf8' : undefined,
        env: {
            ...process.env,
            PIP_CACHE_DIR: pipCacheDir,
            TMPDIR: setupTempDir,
            TMP: setupTempDir,
            TEMP: setupTempDir
        }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
        throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ''}`);
    }
    return options.capture ? result.stdout.trim() : '';
}

function findBootstrapPython() {
    const configured = process.env.CONVERTER_BOOTSTRAP_PYTHON;
    const candidates = configured
        ? [{ command: configured, arguments: [] }]
        : process.platform === 'win32'
            ? [
                { command: 'py', arguments: ['-3.12'] },
                { command: 'python3.12', arguments: [] },
                { command: 'py', arguments: ['-3.11'] },
                { command: 'python3.11', arguments: [] },
                { command: 'py', arguments: ['-3.10'] },
                { command: 'python3.10', arguments: [] },
                { command: 'python', arguments: [] },
                { command: 'python3', arguments: [] }
            ]
            : ['python3.12', 'python3.11', 'python3.10', 'python3']
                .map(command => ({ command, arguments: [] }));

    for (const candidate of candidates) {
        const result = spawnSync(candidate.command, [
            ...candidate.arguments,
            '-c',
            'import sys; print(".".join(map(str, sys.version_info[:3]))); raise SystemExit(sys.version_info < (3, 10))'
        ], { encoding: 'utf8' });
        if (!result.error && result.status === 0) {
            progressLog(
                'setup:converters',
                `using bootstrap Python ${result.stdout.trim()} at ${[candidate.command, ...candidate.arguments].join(' ')}`
            );
            return candidate;
        }
    }

    throw new Error(
        'Python 3.10+ was not found. Install Python 3.12 or set CONVERTER_BOOTSTRAP_PYTHON.'
    );
}

function main() {
    if (!fs.existsSync(requirementsPath)) {
        throw new Error(`Missing converter requirements: ${requirementsPath}`);
    }
    if (clean && fs.existsSync(environmentDir)) {
        progressLog('setup:converters', `removing generated environment ${environmentDir}`);
        fs.rmSync(environmentDir, { recursive: true, force: true });
    }
    fs.mkdirSync(pipCacheDir, { recursive: true });
    fs.mkdirSync(setupTempDir, { recursive: true });

    const bootstrapPython = findBootstrapPython();
    const environmentPython = defaultDoclingPythonPath();
    if (!fs.existsSync(environmentPython)) {
        fs.mkdirSync(path.dirname(environmentDir), { recursive: true });
        run(bootstrapPython.command, [...bootstrapPython.arguments, '-m', 'venv', environmentDir]);
    }

    run(environmentPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip']);
    run(environmentPython, [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--requirement',
        requirementsPath
    ]);

    const installedVersion = run(environmentPython, [
        '-c',
        `import importlib.metadata; print(importlib.metadata.version("${converters.pdf.distribution}"))`
    ], { capture: true });
    if (installedVersion !== converters.pdf.version) {
        throw new Error(`Expected Docling ${converters.pdf.version}, installed ${installedVersion}.`);
    }
    const installedCommit = run(environmentPython, [
        '-c',
        [
            'import importlib.metadata, json',
            `dist = importlib.metadata.distribution("${converters.pdf.distribution}")`,
            'direct_url = json.loads(dist.read_text("direct_url.json"))',
            'print(direct_url["vcs_info"]["commit_id"])'
        ].join('; ')
    ], { capture: true });
    if (installedCommit !== converters.pdf.commit) {
        throw new Error(`Expected Docling commit ${converters.pdf.commit}, installed ${installedCommit}.`);
    }

    const manifestPath = path.join(projectRoot, 'output', 'tools', 'converters.json');
    const manifest = {
        installedAt: new Date().toISOString(),
        epub: converters.epub,
        pdf: {
            ...converters.pdf,
            resolvedCommit: installedCommit,
            python: environmentPython
        }
    };
    const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, manifestPath);
    progressLog('setup:converters', `ready: epub2md ${converters.epub.version}; Docling ${installedVersion}`);
}

try {
    main();
} catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}

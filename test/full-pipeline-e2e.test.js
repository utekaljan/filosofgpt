'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function snapshotMarkdown(root) {
    const result = [];
    function visit(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.name.endsWith('.md')) result.push({
                path: path.relative(root, absolute),
                hash: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
            });
        }
    }
    visit(root);
    return result;
}

function createFakeCodex(binDir) {
    fs.mkdirSync(binDir, { recursive: true });
    const executable = path.join(binDir, 'codex');
    fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli synthetic-test'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in for test'); process.exit(0); }
const schema = args[args.indexOf('--output-schema') + 1];
const output = args[args.indexOf('--output-last-message') + 1];
function write(value) { fs.writeFileSync(output, JSON.stringify(value)); }
function readInput(callback) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => callback(input));
}
if (schema.endsWith('classification-result.schema.json')) {
  readInput(input => {
    const works = JSON.parse(input).works;
    write({ results: works.map(work => {
      const source = work.variants[0].path;
      const logic = source.includes('Logic');
      return {
        id: work.id, author: logic ? 'Example Logician' : 'Example Political Writer',
        title: logic ? 'Logic Example' : 'Politics Example', language: 'English', content_type: 'book',
        summary_cz: 'Syntetický automaticky klasifikovaný test.',
        target: logic ? 'FilosofGPT' : 'PolyhistorGPT', relevance_score: 95, priority_score: 95,
        confidence: 'high', reason_cz: logic ? 'Patří do filosofie a logiky.' : 'Patří do politické teorie.',
        canonical_key: (logic ? 'example logician | logic example' : 'example political writer | politics example'),
        edition_note: '', evidence: 'provided_metadata'
      };
    }) });
  });
} else {
  if (args[args.length - 1] !== '-') {
    console.error('Curation prompt must use the stdin sentinel.');
    process.exit(90);
  }
  readInput(prompt => {
    if (process.env.FAKE_CODEX_CAPTURE) {
      fs.writeFileSync(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({ args, prompt }));
    }
    if (process.env.FAKE_CODEX_ECHO_AND_FAIL === '1') {
      process.stdout.write(prompt);
      process.stderr.write(prompt);
      process.exitCode = 47;
      return;
    }
    if (schema.endsWith('curation-atlas.schema.json')) {
      const corpus = /(?:pro|for) (FilosofGPT|PolyhistorGPT)/.exec(prompt)?.[1] || 'FilosofGPT';
      write({ corpus, mission_summary_cz: 'Veřejný syntetický test.', focus_areas: [
        { key: 'primary', title_cz: 'Hlavní', description_cz: 'Hlavní oblast.', weight: 5, minimum_distinct_authors: 1 },
        { key: 'context', title_cz: 'Kontext', description_cz: 'Kontextová oblast.', weight: 3, minimum_distinct_authors: 1 },
        { key: 'methods', title_cz: 'Metody', description_cz: 'Metodická oblast.', weight: 2, minimum_distinct_authors: 1 }
      ], must_include_works: [], author_policies: [], exact_duplicate_groups: [], containment_relations: [], selection_rules_cz: ['Vybrat relevantní čitelné zdroje.'] });
      return;
    }
    const batchId = /Batch ID je (curation-[0-9]+)/.exec(prompt)?.[1];
    const context = JSON.parse(prompt.split('AUTORSKÝ KONTEXT' + String.fromCharCode(10)).pop());
    write({ batch_id: batchId, results: context.decisionWorkIds.map((id, index) => ({
      id, canonical_work_id: id, identity_group_key: 'identity-' + id, edition_group_key: 'edition-' + id,
      scope: 'standalone_work', contains_work_ids: [], contained_by_work_ids: [], topic_keys: ['primary'],
      portfolio_role: 'core', comparative_priority: 95, author_rank: index + 1, standalone_value: 'high',
      reason_cz: 'Silný samostatný zdroj pro cílový korpus.'
    })) });
  });
}
`, 'utf8');
    fs.chmodSync(executable, 0o755);
}

test('canonical command runs inventory through merged audit deterministically', { timeout: 60_000 }, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'filosofgpt-full-'));
    const isolatedProject = path.join(workspace, 'project');
    try {
        fs.mkdirSync(isolatedProject, { recursive: true });
        fs.cpSync(path.join(projectRoot, 'src'), path.join(isolatedProject, 'src'), { recursive: true });
        fs.copyFileSync(path.join(projectRoot, 'pipeline-config.json'), path.join(isolatedProject, 'pipeline-config.json'));
        fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(isolatedProject, 'node_modules'));
        const fakeBin = path.join(workspace, 'bin');
        createFakeCodex(fakeBin);
        const input = path.join(isolatedProject, 'input');
        fs.mkdirSync(input);
        const prose = Array.from({ length: 80 }, (_, index) => (
            `Paragraph ${index + 1}. This synthetic public fixture contains enough ordinary words to exercise conversion, selection, merging, retrieval structure, and audit without any private book material.`
        )).join('\n\n');
        fs.writeFileSync(path.join(input, 'Logic Example.md'), `# Logic Example\n\n${prose}\n`, 'utf8');
        fs.writeFileSync(path.join(input, 'Politics Example.md'), `# Politics Example\n\n${prose}\n`, 'utf8');
        const run = () => spawnSync(process.execPath, ['src/cli/run-all.js'], {
            cwd: isolatedProject,
            encoding: 'utf8',
            timeout: 55_000,
            env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` }
        });
        let result = run();
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        const output = path.join(isolatedProject, 'output');
        assert.deepEqual(fs.readdirSync(output).sort(), ['books', 'markdown', 'merged', 'reports', 'state']);
        const firstMerged = snapshotMarkdown(path.join(output, 'merged'));
        assert.equal(firstMerged.length, 2);
        const audit = JSON.parse(fs.readFileSync(path.join(output, 'reports', 'audit.json'), 'utf8'));
        assert.equal(audit.ok, true);
        assert.equal(audit.summary.errors, 0);
        const decisions = JSON.parse(fs.readFileSync(path.join(output, 'reports', 'decisions.json'), 'utf8'));
        assert.deepEqual(decisions.summary, { total: 2, selected: 2, rejectedSemantic: 0, excludedAfterConversion: 0, other: 0 });
        assert.ok(decisions.decisions.every(entry => entry.qualityPreflight.status === 'ok'));

        result = run();
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(snapshotMarkdown(path.join(output, 'merged')), firstMerged);
        const allOutputText = fs.readdirSync(path.join(output, 'merged'), { recursive: true })
            .map(String).join('\n');
        assert.doesNotMatch(allOutputText, /Fixture Author Alpha|Fixture Author Beta/);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('passes curation prompts through stdin and omits echoed prompts from diagnostics', { timeout: 20_000 }, () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'filosofgpt-curation-transport-'));
    const isolatedProject = path.join(workspace, 'project');
    const privateMarker = 'SYNTHETIC_CURATOR_PROMPT_PRIVACY_MARKER';
    try {
        fs.mkdirSync(isolatedProject, { recursive: true });
        fs.cpSync(path.join(projectRoot, 'src'), path.join(isolatedProject, 'src'), { recursive: true });
        fs.copyFileSync(path.join(projectRoot, 'pipeline-config.json'), path.join(isolatedProject, 'pipeline-config.json'));
        fs.symlinkSync(path.join(projectRoot, 'node_modules'), path.join(isolatedProject, 'node_modules'));

        const catalogDir = path.join(isolatedProject, 'output', 'state');
        fs.mkdirSync(catalogDir, { recursive: true });
        fs.writeFileSync(path.join(catalogDir, 'catalog.json'), JSON.stringify({
            summary: { unclassifiedCandidateCount: 0 },
            works: [{
                id: 'fixture_transport_work',
                author: 'Fixture Author Transport',
                title: 'Synthetic Transport Work',
                summaryCz: privateMarker,
                target: 'FilosofGPT',
                contentType: 'book',
                relevanceScore: 95,
                priorityScore: 95,
                primarySource: { relativePath: 'synthetic/transport.md' },
                sourceVariants: [{ relativePath: 'synthetic/transport.md' }]
            }]
        }));

        const fakeBin = path.join(workspace, 'bin');
        const capturePath = path.join(workspace, 'codex-capture.json');
        createFakeCodex(fakeBin);
        const result = spawnSync(process.execPath, [
            'src/pipeline/prioritization/curate-corpora.js',
            '--corpus=FilosofGPT',
            '--atlas-only',
            '--attempts=1'
        ], {
            cwd: isolatedProject,
            encoding: 'utf8',
            timeout: 15_000,
            env: {
                ...process.env,
                PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
                FAKE_CODEX_CAPTURE: capturePath,
                FAKE_CODEX_ECHO_AND_FAIL: '1'
            }
        });

        assert.notEqual(result.status, 0);
        const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
        assert.equal(capture.args.at(-1), '-');
        assert.doesNotMatch(capture.args.join('\n'), new RegExp(privateMarker));
        assert.match(capture.prompt, new RegExp(privateMarker));
        const diagnostics = `${result.stdout}\n${result.stderr}`;
        assert.doesNotMatch(diagnostics, new RegExp(privateMarker));
        assert.match(diagnostics, /diagnostic streams were omitted to prevent curation prompt disclosure/i);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

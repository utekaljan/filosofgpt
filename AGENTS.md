# Contributor map

This directory is a sanitized public implementation of the FilosofGPT and
PolyhistorGPT corpus pipeline. Keep private books, generated Markdown, model
output, credentials, caches, and machine-specific paths outside the published
tree. `input/`, `output/`, and `node_modules/` are runtime-only and ignored.

## Project identity

Do not replace the README's personal project description with a generic pipeline
summary. FilosofGPT processes the author's EPUB/PDF collection, uses repeated LLM
calls to classify relevance, selects approximately 150 books, annotates books,
chapters, and pages, and packages the result into approximately 20 large
Markdown sources for the FilosofGPT and PolyhistorGPT custom GPTs. These are
descriptive figures from the personal project, not fixed public configuration
values.

The sole checked-in EPUB under `examples/` is the first-party synthetic fixture
documented in `examples/README.md`. Preserve its digest and fully invented
content boundary. `npm run demo` must stay an offline, private-data-free path
through the standalone ingest adapter; it is distinct from the canonical
`npm run ingest`/`npm run master` workflow. Do not replace it with a real work,
excerpt, bibliographic record, private identifier, or corpus-derived fixture.

## Converter stack

- EPUB conversion uses the exact root dependency `epub2md@1.6.3`.
- PDF conversion uses the official `docling-slim` distribution at version
  `2.123.1`, pinned to the exact Git commit in
  `tools/converters/requirements.txt`.
- PDF.js is limited to short catalog-classification samples. It is not a
  PDF-to-Markdown converter.
- Upstream converter source trees must not be copied into `vendor/` or another
  project directory. Do not add an AGPL converter.

Keep versions, commits, licenses, `src/lib/converter-stack.js`, dependency
files, `THIRD_PARTY_NOTICES.md`, documentation, and tests consistent whenever
the stack changes. Generated Python environments and model caches belong only
below `output/tools/`.

## Public repository maintenance

First-party code, documentation, and synthetic fixtures are licensed under the
root MIT license. Security reports use GitHub private vulnerability reporting;
do not publish an email address or vulnerability details in issues. Dependabot
watches npm dependencies and GitHub Actions. Update the commit-pinned Docling
dependency manually so its requirement, converter metadata, notices,
documentation, and tests stay consistent in the same change.

Pass dynamic classification data and corpus-specific curation prompts through
standard input, never through process arguments. Do not include raw Codex
diagnostic streams in curation errors because they may echo prompt content.

## Conversion behavior

The PDF worker is one persistent JSONL process per corpus. Its stdout is a
machine protocol; diagnostics belong on stderr. OCR and enrichment features
remain disabled unless an explicit future requirement changes that decision.

The canonical pipeline selects one primary source variant per catalog work. If
multiple same-basename formats nevertheless reach the converter, only the
highest-priority one is attempted. Neither layer may activate an alternate
edition or format after failure. Individual source failures do not stop the
corpus, but a missing, incompatible, or unexpectedly terminated global
converter does.

Conversion reports are atomic checkpoints. Reuse requires the current
conversion version and stack ID, matching source path, size, and mtime, plus an
existing output whose byte size matches the report. Continue an interrupted
conversion without `--clean-conversion`; that option deliberately discards the
conversion checkpoint and Markdown outputs. A failed source may be retried on a
later run, but never by substituting another source.

## Verification

Do not commit or publish private source books or smoke outputs. Apart from the
documented synthetic demo, use generated synthetic fixtures or ignored,
isolated runtime directories, then remove private smoke artifacts. Before handoff, run
the syntax checks, `npm test`, `npm run demo`, npm audit, Docling `pip check`,
dependency-pin checks, whitespace checks, and the privacy scan in
`docs/privacy.md`. Do not run the full private corpus merely to verify a code
change.

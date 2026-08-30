# Architecture

Both `npm run ingest` and `npm run master` execute
`src/cli/run-all.js`. The workflow is incremental: a successful preflight
preserves compatible checkpoints, converter tooling, and completed conversions
instead of rebuilding the whole ignored `output/` tree.

1. `inventory-books.js` recursively hashes supported sources and groups likely
   variants.
2. `classify-books.js` extracts a bounded sample with Markdown reading,
   archive inspection or the root `pdfjs-dist` dependency. PDF.js
   is used only here for short text samples. The stage invokes ephemeral,
   read-only `codex exec` with a checked-in JSON Schema and records normalized
   identity, target, relevance, confidence, and a Czech explanation.
3. `curate-corpora.js` applies the public portfolio policy using a corpus-wide
   atlas and per-author structured decisions.
4. `organize-books.js` chooses exactly one primary source per work and creates
   the bounded conversion frontier under `output/books/`.
5. `convert-corpora.js` invokes `convert-books.js` once per requested corpus.
   Markdown is normalized, EPUB uses `epub2md`, and PDF uses one persistent
   Docling JSONL worker. There is no alternate-edition or alternate-format
   repair round.
6. `merge-corpora.js` performs deterministic quality- and size-aware selection.
   Individually failed conversions are omitted as `conversion_failed`.
7. `audit-pipeline.js` checks catalog, staging, Markdown, package indexes,
   duplicates, quality, bytes, and tokens. A missing Markdown caused by an
   individual conversion failure is a warning; a broken global converter stack
   stops the workflow earlier.
8. `generate-book-lists.js` writes deterministic human-readable selected and
   excluded book lists for each corpus.
9. `generate-decisions-report.js` joins classification, curation, conversion,
   and merge evidence into a human-readable reason for every current work.

## Public demo boundary

`npm run demo` does not invoke this full workflow. It calls the standalone
`src/cli/ingest.js` adapter with a first-party synthetic EPUB and equally
synthetic metadata from `examples/`, then writes converted Markdown, a catalog,
and a routed copy below `output/demo/`. It exercises the real `epub2md`
integration, deliberately needs neither Codex nor Docling, and does not claim to
exercise LLM classification, corpus-wide curation, merge, or the final audit.

## Converter process boundary

`src/lib/converter-stack.js` is the single source of truth for converter
versions, commits, licenses, the conversion stack ID, and the generated Docling
environment path. `src/cli/setup-converters.js` creates that environment under
`output/tools/` from `tools/converters/requirements.txt`.

The Python worker creates `DocumentConverter` once, reads one JSON object per
stdin line, and writes one response per stdout line. Docling logs are redirected
to stderr. Raw page-preserving Markdown is written atomically to
`output/temp/conversion/<corpus>/`, then the unchanged project postprocessing
creates the final book Markdown.

The conversion report is an atomic per-book checkpoint. Reuse requires the
current conversion version and stack ID, matching source path/size/mtime, and a
matching existing output size. A selected source is marked attempted before
conversion, so a failed EPUB does not cause a same-basename PDF to be selected.

## Model and privacy boundaries

The canonical `npm run master` model calls use `--ephemeral`, a read-only
sandbox, a temporary working directory, and an output schema through the local
Codex CLI. The optional standalone adapter can instead use the OpenAI Responses
API when explicitly invoked with `--classifier=openai`; that mode reads
`OPENAI_API_KEY` from the environment. No credential, private prompt file,
private corpus, or Git history is bundled or written by the project. The public
classification/curation prompts and schemas are source code. Converter
dependencies are installed from pinned public declarations; their upstream
source trees are not vendored.

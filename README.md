# FilosofGPT

**FilosofGPT** is a **Node.js** and **JavaScript** script that processes my
collection of **EPUB** and **PDF** books. It classifies them by relevance through
repeated **LLM** calls, selects a subset of approximately **150 books**, and
converts them to **Markdown**. It annotates individual books, chapters, and
pages, then combines everything into approximately 20 large Markdown files.
These files serve as sources for my **FilosofGPT** and **PolyhistorGPT** custom
GPTs, which I use to discuss books I have recently read.

This repository is a public, sanitized implementation of that workflow. It does
not include the private book collection, private Custom GPT instructions,
generated corpora, or local model caches. The classification and curation
prompts required by this pipeline are intentionally included as source code.
The approximate corpus and output counts above describe the personal project
rather than hard-coded limits: this public implementation also accepts Markdown
sources and derives every result from the files currently placed in the ignored
`input/` directory.

## Try a synthetic EPUB fixture

The checked-in demo is a small, first-party EPUB created solely for this
repository. Its title, author label, identifier, headings, and prose are all
invented; it contains no real work, excerpt, private-corpus metadata, or
conversation-derived identifier. Its exact contents and SHA-256 digest are
recorded in [examples/README.md](examples/README.md). The fixture exercises real
EPUB conversion, reporting, and routing without Python, Docling, a Codex login,
an API key, or private data. The demo needs Node.js 22.13 or newer, npm, and the
system `unzip` command:

```bash
npm ci
npm run demo
```

Results are written below ignored `output/demo/`. The checked-in metadata avoids
an LLM call so that anyone can run the same conversion locally. This one-document
demo is not a substitute for the full LLM classification and corpus-wide
curation flow.

## Full workflow requirements

- Node.js 24 recommended (22.13 or newer is supported by PDF.js 6);
- Python 3.10 or newer, preferably Python 3.12;
- Git and npm;
- the system `unzip` command for EPUB inspection;
- a locally installed and logged-in Codex CLI with
  `codex exec --output-schema`.

Install the JavaScript dependencies and the pinned PDF converter:

```bash
npm ci
npm run setup:converters
```

`setup:converters` creates only ignored generated files under
`output/tools/`. It installs the official modular `docling-slim`
distribution from the exact Git commit declared in
`tools/converters/requirements.txt`. To rebuild only that generated
environment:

```bash
npm run setup:converters -- --clean
```

## Run the full workflow

Place current `.md`, `.epub`, and `.pdf` files anywhere under `input/`; the
inventory scans it recursively. Then run:

```bash
npm run master
```

`npm run ingest` is an exact alias. To override the model selected by the local
Codex configuration:

```bash
npm run master -- --model=MODEL_NAME
```

A run inventories sources, extracts bounded classification samples, performs
structured classification and portfolio curation, stages one selected source
per work, converts it, packages the usable results, and audits the result. No
application, upload, or external publication is performed.

If the input collection is unchanged and a complete matching catalog already
exists, the downstream stages can be resumed with:

```bash
npm run master -- --skip-classification
```

This skips the two classification passes. Curation still runs, but reuses its
compatible atlas and per-work decisions when the inputs have not changed. Do
not use this option after adding, removing, or replacing source books.

## Conversion stack

- EPUB is converted with the exact npm dependency `epub2md@1.6.3`.
- PDF is converted with Docling `2.123.1` from its exact release commit.
- `pdfjs-dist@6.2.108` is used only to read short PDF samples during catalog
  classification. It is not a PDF-to-Markdown converter.

Docling runs as one persistent Python worker for the whole corpus. Node sends
JSON Lines requests over stdin and receives JSON Lines responses over stdout;
library logs remain on stderr. OCR, table structure, formula, code, picture,
chart, and image enrichment are deliberately disabled. Page boundaries are
preserved as `## Page N` headings.

Docling uses `AcceleratorOptions()`, so its normal environment controls remain
available:

```bash
DOCLING_DEVICE=auto npm run master
DOCLING_DEVICE=cuda DOCLING_NUM_THREADS=12 npm run master
```

`OMP_NUM_THREADS` can also be used where appropriate. Model and framework
caches stay under `output/tools/cache/`. A compatible external environment can
be selected with `DOCLING_PYTHON`; the setup bootstrap interpreter can be
selected with `CONVERTER_BOOTSTRAP_PYTHON`.

Exact versions, upstream commits, and licenses are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Upstream converter source
trees are not copied into this repository.

## Failure, source selection, and resume policy

Primary-source selection first prefers English or Czech variants, then variants
with an unknown language, and finally other languages. Within the same language
tier, format priority is Markdown, then EPUB, then PDF. Only the selected source
is attempted; if it fails, the failure is recorded and another edition or
format is not used as a fallback.

A failure limited to one book creates a `failed: true` conversion record,
leaves no Markdown for that book, and allows the remaining books to continue.
Merge and audit omit it with the reason `conversion_failed`. A missing or
incompatible Docling installation, a worker startup/version failure, or an
unexpected worker exit is a global error and stops the pipeline before merge.

The conversion report is written atomically after every completed, failed, or
skipped book. A successful result is reused only when its conversion version and
stack ID, source path/size/mtime, output existence, and recorded output size all
match. This public checkpoint format starts at version 1. Reports written with a
different version are replaced one by one; matching version-1 results are reused
after an interruption or computer restart, while failed sources may be retried
on a later run.

Resume with the same command, without a clean flag:

```bash
npm run master -- --skip-classification
```

Do not use `--clean-conversion` when continuing an interrupted conversion. It
intentionally deletes the conversion outputs and report before starting again.
If an earlier run was started with that flag and interrupted, resume without it.

## Output

```text
output/
  tools/                         Docling environment and local caches
  state/                         inventory, decisions, catalog, and curation
  books/FilosofGPT/              staged current sources and manifest
  books/PolyhistorGPT/           staged current sources and manifest
  markdown/FilosofGPT/           converted Markdown
  markdown/PolyhistorGPT/        converted Markdown
  merged/FilosofGPT/             final upload-ready package
  merged/PolyhistorGPT/          final upload-ready package
  reports/                       conversion, merge, decisions, and audit data
```

Books classified as `null` remain visible in the catalog and decision report
but are not staged. A relevant book whose conversion fails is reported honestly
and cannot enter a merged package.

## Verification and privacy

```bash
npm test
npm run demo
npm audit --audit-level=high
output/tools/docling-2.123.1/bin/python -m pip check
npm run ingest:preflight
```

The `pip check` path above is for macOS/Linux. On Windows use
`output\tools\docling-2.123.1\Scripts\python.exe -m pip check`.

Tests create temporary fixtures and do not ship private books. The sole tracked
EPUB exception is the explicitly allowlisted synthetic fixture under
`examples/synthetic/`. `input/`, `output/`, `node_modules/`, all PDFs, and every
other EPUB are ignored. Private books and generated results used for local
review must never be force-added or uploaded.

See [docs/architecture.md](docs/architecture.md) and
[docs/privacy.md](docs/privacy.md).

## Security

Report suspected vulnerabilities through GitHub's private vulnerability
reporting form, not through a public issue or discussion. Do not attach private
books, generated corpora, credentials, or machine-specific configuration. See
[SECURITY.md](SECURITY.md) for the reporting policy.

## License

Copyright (c) 2026 Jan Utěkal.

The original code, documentation, and first-party synthetic fixtures in this
repository are available under the [MIT License](LICENSE). Third-party
dependencies and their notices remain subject to their respective licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

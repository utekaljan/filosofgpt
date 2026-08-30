# Source layout

- `cli/run-all.js` — canonical incremental inventory-to-audit workflow.
- `cli/setup-converters.js` — creates the pinned Docling environment below
  `output/tools/`.
- `cli/ingest.js` — standalone format conversion and explicit metadata or
  optional Responses API routing. `npm run demo` uses this adapter; `npm run
  ingest` does not.
- `cli/pipeline-status.js` — read-only summary of generated canonical pipeline
  state.
- `pipeline/catalog/` — source inventory, bounded Markdown/EPUB/PDF samples,
  and structured Codex classification.
- `pipeline/prioritization/` — curation portfolios, primary-source staging,
  and conversion-frontier planning.
- `pipeline/conversion/` — Markdown normalization, `epub2md` integration, and
  the persistent Docling PDF worker. It contains no alternate-source repair.
- `pipeline/packaging/` — retrieval transformation, selection, merge, and
  reports.
- `pipeline/validation/` — independent end-to-end audit.
- `lib/converter-stack.js` — converter versions, licenses, stack identity, and
  Docling environment paths.
- `lib/` — other deterministic shared logic.
- `schemas/` — checked-in structured-response schemas.

The package scripts route both `npm run ingest` and `npm run master` through
`cli/run-all.js`. Input books live in the ignored `input/` folder. In this
package-script workflow, generated checkpoints, conversion reports, Markdown,
converter environments, and caches all stay below ignored `output/`. The
standalone adapter can place converted results at an explicit `--output` path;
its converter environments and caches still remain below project
`output/tools/`.

`npm run demo` is intentionally separate: it converts the first-party synthetic
EPUB under `examples/` through `cli/ingest.js`, applies equally synthetic routing
metadata, and writes only to `output/demo/`. It exercises the real `epub2md`
integration but not the LLM-driven canonical stages.

Normal reruns preserve compatible outputs. A book is reused only when the
converter version/stack ID, source path/size/mtime, and output byte size match
the atomic conversion report. The selected primary source is attempted once per
run; a failure may be retried on a later run, but no alternate edition or format
is substituted.

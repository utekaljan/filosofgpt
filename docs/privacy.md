# Privacy and release boundary

This repository is designed to be publishable without exposing the private
corpus from which the architecture originated.

## Excluded by design

- real source libraries and bibliographic inventories;
- generated corpora, reports, checkpoints, caches, and conversion artifacts;
- private model instructions and prompt templates;
- personal-memory or conversation exports;
- credentials, environment files, editor state, absolute personal paths, and
  private Git history;
- bundled private, unlicensed, or unattributed PDF/EPUB books.

## Included by design

- a tracked but empty `input/` drop folder whose contents are ignored;
- one first-party synthetic EPUB plus equally synthetic routing metadata under
  `examples/`, with its exact contents and digest documented there;
- transparent public classification and curation criteria plus JSON Schemas;
- local integration code for pinned `epub2md`, Docling, and PDF.js dependencies;
- deterministic pipeline code and tests that generate their own temporary
  synthetic PDF/EPUB documents.

`input/`, `output/`, local `.env` files, every PDF, and every EPUB except the
exact synthetic fixture path remain ignored; the deliberately empty
`.env.example` path is allowed if a safe template is ever needed. Tests and
private-corpus verification must use temporary directories and remove them when
finished. The standalone conversion adapter can keep source books and converted
results elsewhere with
`node src/cli/ingest.js --input=/private/path --output=/temporary/path`;
the pinned converter environment and caches still remain in ignored
`output/tools/`.

The upstream converter source trees are not copied into this repository.
`node_modules/` and the Docling environment/model caches under `output/tools/`
are generated and ignored; installed packages retain their own license files.
The repository redistributes its integration code, dependency declarations, and
the first-party synthetic demo fixture. See `THIRD_PARTY_NOTICES.md` for
dependency versions, commits, and attribution.

Conversion is local. In the canonical workflow, semantic classification and
curation use the logged-in Codex CLI. The model receives paths, metadata, and
bounded extracted samples; it does not receive complete source files from this
code. Calls use ephemeral, read-only execution and structured output. The
dynamic classification payload and each corpus-specific curation prompt are
sent through standard input rather than process arguments. Curation failures do
not include raw Codex stdout or stderr because either stream could echo private
prompt content. The
optional standalone `--classifier=openai` mode instead reads `OPENAI_API_KEY`
from the environment and sends a filename plus a bounded Markdown sample to the
OpenAI Responses API. The project does not persist that credential. Users remain
responsible for source licenses, account quota, and the data-handling terms of
their configured model service.

Before publishing changes, run:

```bash
npm ci
npm test
npm run demo
npm run ingest:preflight
npm audit --audit-level=high
git status --short
rg --hidden --no-ignore -n \
  -g '!{.git,node_modules,output,input}/**' \
  -e 'B[E]GIN .*PRIVATE KEY' \
  -e 'gh[p]_' \
  -e 'github[_]pat_' \
  -e 'sk[-][A-Za-z0-9_-]{16,}'
```

The last command should print no matches. The character classes keep the
documented patterns from matching the checklist itself.

When converter behavior changes, additionally run a clean
`npm run setup:converters -- --clean` and Docling `pip check` using the
platform-specific Python path documented in the root README. Run `git status`
only inside an initialized Git checkout.

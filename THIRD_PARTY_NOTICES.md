# Third-party conversion dependencies

This project integrates third-party converters as pinned dependencies. Their
upstream source code is not copied into this repository.

Installed npm and Python artifacts retain their upstream license files. The
generated `node_modules/` and `output/tools/` environments are ignored and are
not redistributed by this repository.

This repository does not redistribute the upstream converter source trees or
generated installations. It redistributes its integration code, dependency
declarations, and one first-party synthetic EPUB fixture. This notice records
project configuration and attribution; it is not legal advice or a warranty
about downstream use.

## epub2md

- Purpose: EPUB parsing and Markdown conversion
- Version: `1.6.3`
- Release commit: `f04a454fab4495298f33a4406fb2f2d7380a7e15`
- Source: <https://github.com/uxiew/epub2MD/tree/v1.6.3>
- Package: <https://www.npmjs.com/package/epub2md/v/1.6.3>
- License: MIT, <https://github.com/uxiew/epub2MD/blob/v1.6.3/LICENSE>
- Copyright notice: Copyright (c) 2021 ChandlerVer5

The package is installed by `npm install` from the exact version recorded in
`package.json` and `package-lock.json`.

## tiktoken JS/WASM bindings

- Purpose: deterministic token counts for the two configured encodings
- Version: `1.0.22`
- Source: <https://github.com/dqbd/tiktoken>
- Package: <https://www.npmjs.com/package/tiktoken/v/1.0.22>
- License: MIT, <https://github.com/dqbd/tiktoken/blob/main/LICENSE>

The exact npm tarball URL and integrity digest are recorded in
`package-lock.json`; the package itself declares the MIT license.

## Docling

- Purpose: PDF layout analysis and Markdown conversion
- Version: `2.123.1`
- Release commit: `d745e9708c1aa207cf4622fb21fdde68267f64ab`
- Source: <https://github.com/docling-project/docling/tree/v2.123.1>
- License: MIT, <https://github.com/docling-project/docling/blob/v2.123.1/LICENSE>
- Copyright notice: Copyright The Docling Contributors

The package is installed from the exact GitHub commit declared in
`tools/converters/requirements.txt`. The official modular distribution
`docling-slim` is installed only with the PDF, local-model and core conversion
extras used here. Its generated Python environment lives under ignored
`output/tools/`, not in the repository.

## PDF.js distribution

- Purpose: small PDF text samples used only during catalog classification;
  it is not the PDF-to-Markdown converter
- Version: `6.2.108`
- Release commit: `0365cbde028bd92e58f2dab1bb70cd30ac7acfd7`
- Source: <https://github.com/mozilla/pdf.js/tree/v6.2.108>
- License: Apache-2.0, <https://github.com/mozilla/pdf.js/blob/v6.2.108/LICENSE>

The package is installed by `npm install` from the exact version recorded in
`package.json` and `package-lock.json`.

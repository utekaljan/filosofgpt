# Synthetic EPUB demo

`synthetic/synthetic-epub-fixture.epub` is a first-party test asset created only
for this repository. Every bibliographic field and every sentence inside it is
invented. It contains no real book, author, excerpt, page number, section title,
private identifier, conversation output, or private-corpus metadata.

The EPUB contains only the standard package files required for a minimal EPUB
2 conversion test:

- `mimetype`;
- `META-INF/container.xml`;
- `OEBPS/content.opf`;
- `OEBPS/toc.ncx`;
- `OEBPS/chapter.xhtml`.

The fixed file has this digest:

- SHA-256: `860a7fe6ad9cfb0ebf3b0082a8ee25a5a65ef6b597ae56f82cacb764ac316527`

`synthetic-catalog.json` contains only the equally invented routing metadata
needed to run the demo without an LLM call. The test in
`test/public-demo.test.js` verifies the digest and confirms that the fixture is
processed by the pinned `epub2md` converter.

The EPUB fixture and its routing metadata are first-party repository content
licensed under the root [MIT License](../LICENSE).

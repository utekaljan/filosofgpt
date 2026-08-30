'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    applyPartContext,
    extractRetrievalSections,
    sourcePayloadHash,
    transformRetrievalMarkdown,
    validateMergedRetrievalMarkdown
} = require('../src/lib/retrieval-markdown');

const collection = {
    id: 'fixture_collection_alpha',
    author: 'Fixture Author Alpha',
    title: 'Synthetic Collected Notes',
    contentType: 'book',
    scope: 'collection'
};

test('wraps a collection page in stable book, section and page context without changing prose', () => {
    const source = [
        '# Fixture Author Alpha - Synthetic Collected Notes',
        '',
        '## Page 10',
        '',
        'A synthetic closing paragraph for the preceding fixture section.',
        '',
        '## Page 11',
        '',
        'A Constructed Section Heading',
        '',
        'This paragraph was written only for the synthetic repository fixture.'
    ].join('\n');
    const transformed = transformRetrievalMarkdown(collection, source);
    const content = applyPartContext(transformed.content, 1, 1);

    assert.match(content, /### SECTION: A Constructed Section Heading/);
    assert.match(content, /#### PAGE: 11/);
    assert.match(content, /\[CORPUS_CONTEXT: BOOK_ID=fixture_collection_alpha .*SECTION=A Constructed Section Heading \| PAGE=11\]/);
    assert.equal(sourcePayloadHash(source), sourcePayloadHash(content));
});

test('recognizes monograph chapters and textbook sections conservatively', () => {
    const source = [
        '# Synthetic Pattern Handbook',
        '',
        '## Page 20',
        '',
        'Chapter 1 — Constructed Introduction',
        '',
        'This deliberately invented paragraph introduces a generic pattern exercise.',
        '',
        '## Page 21',
        '',
        '1.1. Artificial Curve Exercise',
        '',
        'Another fabricated paragraph verifies that numbered sections remain detectable.'
    ].join('\n');
    const transformed = transformRetrievalMarkdown({
        id: 'fixture_handbook_beta',
        author: 'Fixture Author Beta',
        title: 'Synthetic Pattern Handbook',
        contentType: 'book',
        scope: 'reference'
    }, source);

    assert.deepEqual(transformed.sections.map(section => section.type), ['CHAPTER', 'SECTION']);
    assert.deepEqual(transformed.sections.map(section => section.title), [
        'Chapter 1 — Constructed Introduction',
        '1.1. Artificial Curve Exercise'
    ]);
    assert.equal(sourcePayloadHash(source), transformed.sourcePayloadHash);
});

test('validates merged BOOK hierarchy, metadata and repeated retrieval context', () => {
    const transformed = transformRetrievalMarkdown(collection, [
        '# Source title',
        '',
        '## Page 1',
        '',
        'Original paragraph.'
    ].join('\n'));
    const body = [
        '# CORPUS FILE: 04_example.md',
        '',
        '<a id="fixture-collection-alpha-1"></a>',
        '',
        '## BOOK: Fixture Author Alpha — Synthetic Collected Notes',
        '',
        'BOOK_ID: fixture-collection-alpha-1',
        'AUTHOR: Fixture Author Alpha',
        'TITLE: Synthetic Collected Notes',
        '',
        applyPartContext(transformed.content, 1, 1)
    ].join('\n');
    const validation = validateMergedRetrievalMarkdown(body);

    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.bookCount, 1);
    assert.ok(validation.contextCount >= 2);
});

test('extracts local book navigation anchors from retrieval sections', () => {
    const transformed = transformRetrievalMarkdown(collection, [
        '# Source title',
        '',
        '## Page 1',
        '',
        'A Second Constructed Essay',
        '',
        'This is synthetic opening prose written solely for the test fixture.'
    ].join('\n'));
    const sections = extractRetrievalSections(transformed.content);

    assert.equal(sections.length, 1);
    assert.equal(sections[0].title, 'A Second Constructed Essay');
    assert.match(sections[0].anchor, /^retrieval-fixture-collection-alpha-/);
});

test('does not promote running headers or sentence fragments to sections', () => {
    const transformed = transformRetrievalMarkdown({
        id: 'fixture_reference_gamma',
        author: 'Fixture Author Gamma',
        title: 'Synthetic Reference Collection',
        contentType: 'book',
        scope: 'collection'
    }, [
        '# Synthetic Reference Collection',
        '',
        '## Page 30',
        '',
        'A Constructed Running Header 3',
        '',
        'Synthetic prose remains here.',
        '',
        '## Page 31',
        '',
        'A sentence fragment. But despite this',
        '',
        'More synthetic source prose.'
    ].join('\n'));

    assert.deepEqual(transformed.sections, []);
});

test('does not infer free-form monograph sections from figure-like labels', () => {
    const transformed = transformRetrievalMarkdown({
        id: 'fixture_diagram_delta',
        author: 'Fixture Author Delta',
        title: 'Synthetic Diagram Manual',
        contentType: 'book',
        scope: 'reference'
    }, [
        '# Synthetic Diagram Manual',
        '',
        '## Page 40',
        '',
        'Input Output',
        '',
        'Invented figure text and surrounding synthetic prose.'
    ].join('\n'));

    assert.deepEqual(transformed.sections, []);
});

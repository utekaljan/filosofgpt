'use strict';

const crypto = require('crypto');

const PART_PLACEHOLDER = '{{PART}}';
const CONTEXT_PREFIX = '[CORPUS_CONTEXT:';
const SYNTHETIC_ANCHOR_PREFIX = 'retrieval-';

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72);
}

function cleanContextValue(value) {
    return String(value || '')
        .replace(/[\r\n|\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sourcePayloadLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .filter(line => line.trim())
        .filter(line => !/^#{1,6}\s+/.test(line))
        .filter(line => !/^<a id="retrieval-[^"]+"><\/a>$/.test(line))
        .filter(line => !line.startsWith(CONTEXT_PREFIX));
}

function sourcePayloadHash(text) {
    return crypto.createHash('sha256').update(sourcePayloadLines(text).join('\n')).digest('hex');
}

function headingBoundary(line) {
    const match = String(line || '').match(/^#{1,6}\s+(Page|Section)\s+(.+?)\s*$/i);
    if (!match) return null;
    return { kind: match[1].toLowerCase(), value: match[2].trim() };
}

function normalizedWords(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function resemblesRunningHeader(line, book) {
    const normalized = normalizedWords(line);
    const title = normalizedWords(book.title);
    if (!normalized || !title) return false;
    const titleWords = title.split(' ').filter(word => word.length > 3);
    const shared = titleWords.filter(word => normalized.includes(word));
    if (shared.length >= Math.min(3, Math.max(1, titleWords.length))) return true;
    const authorWords = normalizedWords(book.author).split(' ').filter(word => word.length > 2);
    if (authorWords.length >= 2 && authorWords.filter(word => normalized.includes(word)).length >= 2) return true;
    const lineWords = normalized.split(' ').filter(Boolean);
    return lineWords.length <= 3 && authorWords.length > 0 && lineWords.includes(authorWords.at(-1));
}

function normalizeStructuralTitle(value) {
    let title = String(value || '').replace(/\s+/g, ' ').trim();
    if (/^\d+(?:\.\d+)+\.?\s+/.test(title)) title = title.replace(/\s+\d+$/, '');
    title = title.replace(/^(PREFACE|CONTENTS)\s+[ivxlcdm]+$/i, '$1');
    return title;
}

function looksLikeStructuralTitle(line, book) {
    const value = String(line || '').trim();
    if (value.length < 3 || value.length > 150) return false;
    if (/^#{1,6}\s+/.test(value) || /^\[CORPUS_CONTEXT:/.test(value)) return false;
    if (/^Page\s+\d+\b/i.test(value)) return false;
    if (/^[ivxlcdm]+\s+[A-Z][A-Z\s]+$/i.test(value)) return false;
    if (/^[\d\W_]+$/.test(value) || /[.!;:,]$/.test(value)) return false;
    if ((!/^\d+(?:\.\d+)+\.?\s+/.test(value) && /[.!;]\s+\p{Lu}/u.test(value)) || /[©®™]/.test(value) || /\d\s*$/.test(value)) return false;
    const words = value.split(/\s+/).map(word => word.replace(/^[^A-Za-zÀ-Žà-ž\d]+|[^A-Za-zÀ-Žà-ž\d]+$/g, ''));
    if (words.length > 18) return false;
    if (resemblesRunningHeader(value, book)) return false;
    if (/^(part|chapter)\s+(?:[IVXLCDM]+|\d+)\b/i.test(value)) return true;
    if (/^(appendix)(?:\s+[A-Z\d]+)?(?:\s*[—:-]\s*.+)?$/i.test(value)) return true;
    if (/^(preface|foreword|introduction|prologue|epilogue|contents|table of contents|bibliography|references)(?:\s*[—:-]\s*.+)?$/i.test(value)) return true;
    if (/^\d+(?:\.\d+)+\.?\s+[A-ZÀ-Ž]/.test(value)) return true;
    if (/^\d/.test(value)) return false;
    const letters = [...value].filter(character => /[A-Za-zÀ-Žà-ž]/.test(character));
    if (letters.length < 10) return false;
    const visibleCharacters = [...value].filter(character => !/\s/.test(character));
    if (letters.length / visibleCharacters.length < 0.72) return false;
    const uppercaseRatio = letters.filter(character => character === character.toUpperCase()).length / letters.length;
    // Free-form title-case headings are useful for essay collections, but in
    // monographs they are indistinguishable from running heads and figure
    // labels. Monographs still recognize explicit/numbered forms handled above.
    if (book.scope !== 'collection') return false;
    if (uppercaseRatio >= 0.72 && words.length >= 2 && words.length <= 12) return true;
    const insignificantWords = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'versus', 'with']);
    const significantWords = words.filter(word => (
        /[A-Za-zÀ-Žà-ž]/.test(word) && !insignificantWords.has(word.toLowerCase())
    ));
    const titleCaseWords = significantWords.filter(word => /^[A-ZÀ-Ž][A-Za-zÀ-Žà-ž’'\-]*$/.test(word));
    return significantWords.length >= 2 && significantWords.length <= 12 && titleCaseWords.length / significantWords.length >= 0.8;
}

function classifyStructuralTitle(title, book) {
    if (/^part\b/i.test(title)) return 'PART';
    if (/^chapter\b/i.test(title) || (/^\d+\s+/.test(title) && !/^\d+\.\d+/.test(title))) return 'CHAPTER';
    if (/^\d+\.\d+/.test(title)) return 'SECTION';
    if (/^appendix\b/i.test(title)) return 'APPENDIX';
    if (/^preface\b/i.test(title)) return 'PREFACE';
    if (/^foreword\b/i.test(title)) return 'FOREWORD';
    if (/^introduction\b/i.test(title)) return 'INTRODUCTION';
    if (/^(contents|table of contents)\b/i.test(title)) return 'CONTENTS';
    if (/^(bibliography|references)\b/i.test(title)) return 'REFERENCES';
    if (book.scope === 'collection') return 'SECTION';
    if (book.contentType === 'paper') return 'SECTION';
    return 'SECTION';
}

function findLeadingStructuralTitle(blockLines, book) {
    const candidates = [];
    for (let index = 0; index < blockLines.length && candidates.length < 2; index += 1) {
        const line = blockLines[index].trim();
        if (!line) continue;
        candidates.push({ line, index });
    }
    if (/^\d+$/.test(candidates[0]?.line || '') && looksLikeStructuralTitle(candidates[1]?.line || '', book)) {
        return normalizeStructuralTitle(`${candidates[0].line} ${candidates[1].line}`);
    }
    const candidate = candidates[0];
    if (!candidate || !looksLikeStructuralTitle(candidate.line, book)) return '';
    // A genuine page-opening title is normally set off from the following
    // prose. Requiring that visual boundary prevents sentence fragments and
    // running headers from being promoted merely because they use title case.
    if (blockLines[candidate.index + 1]?.trim()) return '';
    const following = blockLines.slice(candidate.index + 1).find(line => line.trim())?.trim() || '';
    if (following && following.length < 35 && looksLikeStructuralTitle(following, book)) return '';
    return normalizeStructuralTitle(candidate.line);
}

function renderContext(book, state = {}) {
    const fields = [
        `BOOK_ID=${cleanContextValue(book.id)}`,
        `AUTHOR=${cleanContextValue(book.author)}`,
        `TITLE=${cleanContextValue(book.title)}`,
        `PART=${PART_PLACEHOLDER}`
    ];
    if (state.sectionType && state.sectionTitle) fields.push(`${state.sectionType}=${cleanContextValue(state.sectionTitle)}`);
    if (state.boundaryKind && state.boundaryValue) fields.push(`${state.boundaryKind.toUpperCase()}=${cleanContextValue(state.boundaryValue)}`);
    return `${CONTEXT_PREFIX} ${fields.join(' | ')}]`;
}

function demoteNestedHeadings(lines) {
    return lines.map(line => {
        const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (!match) return line;
        return `##### SOURCE HEADING: ${match[1]}`;
    });
}

function transformRetrievalMarkdown(book, sourceText) {
    const original = String(sourceText || '').replace(/\r\n/g, '\n').trim();
    const lines = original.split('\n');
    const output = [];
    const sections = [];
    const sectionsByKey = new Map();
    let sectionIndex = 0;
    let currentSection = null;

    const sourceTitle = lines[0]?.match(/^#{1,6}\s+(.+?)\s*$/);
    let cursor = sourceTitle ? 1 : 0;
    if (sourceTitle) {
        output.push(`### SOURCE TITLE: ${sourceTitle[1]}`, '', renderContext(book), '');
    } else {
        output.push('### FRONT MATTER: Source opening', '', renderContext(book), '');
    }

    while (cursor < lines.length) {
        const boundary = headingBoundary(lines[cursor]);
        if (!boundary) {
            const nextBoundary = lines.findIndex((line, index) => index > cursor && headingBoundary(line));
            const end = nextBoundary < 0 ? lines.length : nextBoundary;
            const nestedLines = demoteNestedHeadings(lines.slice(cursor, end));
            let charactersSinceContext = 0;
            for (const line of nestedLines) {
                output.push(line);
                charactersSinceContext += line.length + 1;
                if (!line.trim() && charactersSinceContext >= 4500) {
                    output.push(renderContext(book, {
                        sectionType: currentSection?.type,
                        sectionTitle: currentSection?.title
                    }), '');
                    charactersSinceContext = 0;
                }
            }
            cursor = end;
            continue;
        }

        let end = cursor + 1;
        while (end < lines.length && !headingBoundary(lines[end])) end += 1;
        const blockLines = lines.slice(cursor + 1, end);
        const structuralTitle = findLeadingStructuralTitle(blockLines, book);
        if (structuralTitle && structuralTitle !== currentSection?.title) {
            const type = classifyStructuralTitle(structuralTitle, book);
            if (currentSection?.type === 'CONTENTS' && !['CHAPTER', 'PART', 'INTRODUCTION'].includes(type)) {
                output.push(
                    `#### ${boundary.kind === 'page' ? 'PAGE' : 'SOURCE SECTION'}: ${boundary.value}`,
                    '',
                    renderContext(book, {
                        sectionType: currentSection.type,
                        sectionTitle: currentSection.title,
                        boundaryKind: boundary.kind,
                        boundaryValue: boundary.value
                    }),
                    '',
                    ...demoteNestedHeadings(blockLines)
                );
                cursor = end;
                continue;
            }
            const sectionKey = `${type}|${normalizedWords(structuralTitle)}`;
            const knownSection = sectionsByKey.get(sectionKey);
            if (knownSection) {
                currentSection = knownSection;
            } else {
                sectionIndex += 1;
                const anchor = `${SYNTHETIC_ANCHOR_PREFIX}${slugify(book.id)}-${sectionIndex}-${slugify(structuralTitle) || 'section'}`;
                currentSection = { type, title: structuralTitle, anchor };
                sections.push(currentSection);
                sectionsByKey.set(sectionKey, currentSection);
                output.push('', `<a id="${anchor}"></a>`, '', `### ${type}: ${structuralTitle}`, '');
            }
        }
        const boundaryLabel = boundary.kind === 'page' ? 'PAGE' : 'SOURCE SECTION';
        output.push(
            `#### ${boundaryLabel}: ${boundary.value}`,
            '',
            renderContext(book, {
                sectionType: currentSection?.type,
                sectionTitle: currentSection?.title,
                boundaryKind: boundary.kind,
                boundaryValue: boundary.value
            }),
            '',
            ...demoteNestedHeadings(blockLines)
        );
        cursor = end;
    }

    const content = output.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
    const sourceHash = sourcePayloadHash(original);
    const transformedHash = sourcePayloadHash(content);
    if (sourceHash !== transformedHash) {
        throw new Error(`Retrieval transformation changed source payload for ${book.author} — ${book.title}.`);
    }
    return {
        content,
        sections,
        sourcePayloadHash: sourceHash,
        sourcePayloadLineCount: sourcePayloadLines(original).length,
        contextCount: (content.match(/^\[CORPUS_CONTEXT:/gm) || []).length
    };
}

function applyPartContext(content, unitIndex, unitCount) {
    return String(content || '').replaceAll(PART_PLACEHOLDER, `${unitIndex}/${unitCount}`);
}

function extractRetrievalSections(content) {
    const lines = String(content || '').split(/\r?\n/);
    const sections = [];
    for (let index = 0; index < lines.length - 2; index += 1) {
        const anchor = lines[index].match(/^<a id="(retrieval-[^"]+)"><\/a>$/)?.[1];
        if (!anchor) continue;
        const heading = lines.slice(index + 1, index + 4).find(line => /^###\s+/.test(line));
        const match = heading?.match(/^###\s+([A-Z ]+):\s+(.+)$/);
        if (match) sections.push({ anchor, type: match[1], title: match[2] });
    }
    return sections;
}

function validateMergedRetrievalMarkdown(text) {
    const lines = String(text || '').split(/\r?\n/);
    const errors = [];
    let inBook = false;
    let bookCount = 0;
    let contextCount = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^## BOOK: /.test(line)) {
            inBook = true;
            bookCount += 1;
            const nearby = lines.slice(index + 1, index + 20).join('\n');
            if (!/^BOOK_ID: \S+/m.test(nearby)) errors.push(`Book at line ${index + 1} is missing BOOK_ID.`);
            if (!/^AUTHOR: /m.test(nearby) || !/^TITLE: /m.test(nearby)) errors.push(`Book at line ${index + 1} is missing author/title metadata.`);
            continue;
        }
        if (inBook && /^#\s+/.test(line)) inBook = false;
        if (inBook && /^#{1,2}\s+/.test(line)) errors.push(`Illegal heading level inside book at line ${index + 1}: ${line}`);
        if (line.startsWith(CONTEXT_PREFIX)) contextCount += 1;
        if (/^#### (PAGE|SOURCE SECTION): /.test(line)) {
            const nearby = lines.slice(index + 1, index + 7);
            if (!nearby.some(value => value.startsWith(CONTEXT_PREFIX))) {
                errors.push(`Boundary at line ${index + 1} has no nearby CORPUS_CONTEXT.`);
            }
        }
    }
    if (!bookCount) errors.push('No BOOK sections found.');
    if (!contextCount) errors.push('No CORPUS_CONTEXT markers found.');
    return { valid: errors.length === 0, errors, bookCount, contextCount };
}

module.exports = {
    applyPartContext,
    extractRetrievalSections,
    sourcePayloadHash,
    sourcePayloadLines,
    transformRetrievalMarkdown,
    validateMergedRetrievalMarkdown
};

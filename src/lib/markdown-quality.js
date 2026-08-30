'use strict';

function countWords(text) {
    return String(text || '').match(/\S+/g)?.length || 0;
}

function countMojibakeSignals(text) {
    return (String(text || '').match(/(?:ï¿½|â€|Ã.|\uFFFD)/g) || []).length;
}

function inspectMarkdownQuality(text, minimumUsefulBytes = 2000) {
    const value = String(text || '');
    const bytes = Buffer.byteLength(value, 'utf8');
    const words = countWords(value);
    const mojibakeSignals = countMojibakeSignals(value);
    const hardReasons = [];
    const warnings = [];
    if (bytes < minimumUsefulBytes) hardReasons.push('too_small');
    if (words < 300) hardReasons.push('too_few_words');
    if (mojibakeSignals > Math.max(20, words / 500)) warnings.push('heavy_mojibake');
    return {
        bytes,
        words,
        mojibakeSignals,
        mojibakePerThousandWords: words ? mojibakeSignals * 1000 / words : 0,
        hardReasons,
        warnings
    };
}

function isSeverelyCorruptedLine(line) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed)) return false;
    const replacementCount = countMojibakeSignals(trimmed);
    if (replacementCount < 4) return false;
    const visibleCharacters = trimmed.replace(/\s/g, '').length || 1;
    const letterCharacters = (trimmed.match(/\p{L}/gu) || []).length;
    const wordLike = (trimmed.match(/[\p{L}\p{N}]{2,}/gu) || []).length;
    const replacementDensity = replacementCount / visibleCharacters;
    return (
        replacementCount >= 8 && replacementDensity >= 0.08 ||
        replacementCount >= 4 && replacementDensity >= 0.14 ||
        replacementCount >= 6 && letterCharacters / visibleCharacters < 0.18 && wordLike < 5
    );
}

/**
 * Remove only locally unusable OCR debris (typically graphs or destroyed
 * formula-only rows). Isolated replacement characters inside readable prose
 * remain present and are reported as quality metadata instead of excluding the
 * whole book.
 */
function removeSeverelyCorruptedPassages(text) {
    const lines = String(text || '').split(/\r?\n/);
    const kept = [];
    let removedLineCount = 0;
    let removedBytes = 0;
    for (const line of lines) {
        if (isSeverelyCorruptedLine(line)) {
            removedLineCount += 1;
            removedBytes += Buffer.byteLength(`${line}\n`, 'utf8');
        } else {
            kept.push(line);
        }
    }
    return {
        text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
        removedLineCount,
        removedBytes
    };
}

module.exports = {
    countMojibakeSignals,
    countWords,
    inspectMarkdownQuality,
    isSeverelyCorruptedLine,
    removeSeverelyCorruptedPassages
};

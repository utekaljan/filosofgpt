'use strict';

const { asciiKey, contributorKeys } = require('./corpus-pipeline');

const maximumMergedFileNameLength = 80;
const maximumSurnamesInFileName = 4;

function contributorSurnames(author) {
    const surnames = contributorKeys(author).map(contributor => {
        const words = asciiKey(contributor).split(/\s+/).filter(Boolean);
        return words[words.length - 1] || '';
    }).filter(Boolean);
    return [...new Set(surnames)];
}

function rankedBucketSurnames(bucket) {
    const scores = new Map();
    for (const unit of bucket.units || []) {
        const surnames = contributorSurnames(unit.author);
        const effectiveSurnames = surnames.length ? surnames : ['books'];
        const weight = Math.max(1, unit.bytes || unit.tokenCount || 1) / effectiveSurnames.length;
        for (const surname of effectiveSurnames) {
            scores.set(surname, (scores.get(surname) || 0) + weight);
        }
    }
    return [...scores.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([surname]) => surname);
}

function buildMergedFileName(bucket, index, options = {}) {
    const maximumLength = options.maximumLength || maximumMergedFileNameLength;
    const maximumSurnames = options.maximumSurnames || maximumSurnamesInFileName;
    const prefix = `${String(index + 1).padStart(2, '0')}_`;
    const extension = '.md';
    const availableStemLength = Math.max(1, maximumLength - prefix.length - extension.length);
    const selected = [];
    for (const surname of rankedBucketSurnames(bucket).slice(0, maximumSurnames)) {
        const candidate = [...selected, surname].join('_');
        if (candidate.length > availableStemLength) break;
        selected.push(surname);
    }
    let stem = selected.join('_');
    if (!stem) {
        stem = (rankedBucketSurnames(bucket)[0] || 'books').slice(0, availableStemLength);
    }
    return `${prefix}${stem || 'books'}${extension}`;
}

module.exports = {
    buildMergedFileName,
    contributorSurnames,
    maximumMergedFileNameLength,
    maximumSurnamesInFileName,
    rankedBucketSurnames
};

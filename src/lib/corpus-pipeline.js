'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../..');
const configPath = path.join(projectRoot, 'pipeline-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function resolveProjectPath(relativeOrAbsolute) {
    return path.isAbsolute(relativeOrAbsolute)
        ? relativeOrAbsolute
        : path.join(projectRoot, relativeOrAbsolute);
}

const outputRoot = resolveProjectPath(config.outputDir);
for (const key of ['stateDir', 'booksDir', 'markdownDir', 'mergedDir', 'reportsDir']) {
    const configuredPath = resolveProjectPath(config[key]);
    const relative = path.relative(outputRoot, configuredPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`pipeline-config.json: ${key} must be a child of outputDir (${config.outputDir}).`);
    }
}

function ensureDirectory(directoryPath) {
    fs.mkdirSync(directoryPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
    ensureDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function jsonWithoutVolatileFields(value, volatileFields) {
    if (Array.isArray(value)) return value.map(item => jsonWithoutVolatileFields(item, volatileFields));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !volatileFields.has(key))
        .map(([key, child]) => [key, jsonWithoutVolatileFields(child, volatileFields)]));
}

function writeJsonAtomicIfChanged(filePath, value, volatileFieldNames = ['generatedAt']) {
    const existing = readJsonIfExists(filePath);
    const volatileFields = new Set(volatileFieldNames);
    const stableValue = jsonWithoutVolatileFields(value, volatileFields);
    const stableExisting = jsonWithoutVolatileFields(existing, volatileFields);
    if (existing && JSON.stringify(stableExisting) === JSON.stringify(stableValue)) {
        return false;
    }
    writeJsonAtomic(filePath, value);
    return true;
}

function readJsonIfExists(filePath, fallback = null) {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonLinesAtomic(filePath, values) {
    ensureDirectory(path.dirname(filePath));
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    const body = values.map(value => JSON.stringify(value)).join('\n');
    fs.writeFileSync(temporaryPath, body ? `${body}\n` : '', 'utf8');
    fs.renameSync(temporaryPath, filePath);
}

function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function asciiKey(value) {
    return normalizeWhitespace(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function cleanTitleHint(value) {
    return normalizeWhitespace(String(value || '')
        .replace(/^title:\s*/i, '')
        .replace(/[_]+/g, ' ')
        .replace(/\s+--\s+isbn\d*[\s\S]*$/i, '')
        .replace(/\s+--\s+[a-f0-9]{16,}[\s\S]*$/i, '')
        .replace(/\s*\((?:copy|retail|ebook|pdf)\s*\d*\)\s*$/i, '')
        .replace(/\s+\(\d+\)\s*$/, ''));
}

function isUsefulMetadataValue(value, kind) {
    const cleaned = normalizeWhitespace(value);
    if (!cleaned || /^(?:\[?no data\]?|unknown|untitled|null|none)$/i.test(cleaned)) {
        return false;
    }
    if (kind === 'title' && /^(?:pii\s*:|microsoft word\b|c\d+$|document\d*$|\d*[ _-]*cover\b|\d+\s+introduction$)/i.test(cleaned)) {
        return false;
    }
    if (kind === 'author' && /^(?:administrator|user|owner|scanner|uploader|unknown)$/i.test(cleaned)) {
        return false;
    }
    return true;
}

function parseNameHints(relativePath, metadata = {}) {
    const extension = path.extname(relativePath);
    const rawBase = cleanTitleHint(path.basename(relativePath, extension));
    const parts = rawBase.split(/\s+-\s+/).map(normalizeWhitespace).filter(Boolean);
    const parentParts = path.dirname(relativePath).split(path.sep).filter(part => part && part !== '.');
    let author = isUsefulMetadataValue(metadata.author, 'author') ? normalizeWhitespace(metadata.author) : '';
    const metadataTitle = isUsefulMetadataValue(metadata.title, 'title') ? normalizeWhitespace(metadata.title) : '';
    let title = metadataTitle;

    const bracketedAuthor = rawBase.match(/^\[([^\]]+)]\s*(.+)$/);
    const byAuthor = rawBase.match(/^(.{4,}?)\s+by\s+(.{3,80})$/i);
    if (!author && bracketedAuthor) {
        author = bracketedAuthor[1].replace(/\s*,\s*/g, ', ');
    }
    if (!title && bracketedAuthor) {
        title = bracketedAuthor[2];
    }
    if (!author && byAuthor) {
        author = byAuthor[2];
    }
    if (!title && byAuthor) {
        title = byAuthor[1];
    }

    if (!title && parts.length >= 2) {
        title = parts.slice(1).join(' - ');
    }
    if (!author && parts.length >= 2) {
        author = parts[0];
    }
    if (!title) {
        title = rawBase;
    }

    if (!author && parentParts.length > 0) {
        const topFolder = parentParts[0];
        if (/\(\s*\d+\s+books?\b/i.test(topFolder) || /^[^,]{2,50},\s*[^,]{2,50}(?:\s*\([^)]*\))?$/.test(topFolder)) {
            author = topFolder.replace(/\s*\([^)]*\)\s*$/, '');
        } else {
            const ebooksOf = topFolder.match(/^ebooks?\s+of\s+(.+)$/i);
            if (ebooksOf) author = ebooksOf[1];
        }
    }

    return {
        author: cleanTitleHint(author),
        title: cleanTitleHint(title),
        rawBase,
        context: parentParts.slice(-3).join(' / ')
    };
}

function removeEditionNoise(value) {
    return asciiKey(value)
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b(?:edition|edn|revised|expanded|illustrated|retail|ebook|press|publisher)\b/g, ' ')
        .replace(/\b(?:oxford|cambridge|penguin|routledge|springer|harvard|princeton|viking|anchor|norton)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function workHintKey(hints) {
    const author = asciiKey(hints.author);
    const title = removeEditionNoise(hints.title);
    if (title.length < 8) {
        return '';
    }
    if (!author && title.split(' ').length < 4) {
        return '';
    }
    return `${author}|${title}`;
}

function formatPriority(extension) {
    const index = config.sourcePriority.indexOf(extension.toLowerCase());
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function compareSourceVariants(a, b) {
    const formatDifference = formatPriority(a.extension) - formatPriority(b.extension);
    if (formatDifference !== 0) {
        return formatDifference;
    }

    const aNoise = /(?:\bcopy\b|\(\d+\)|download)/i.test(a.relativePath) ? 1 : 0;
    const bNoise = /(?:\bcopy\b|\(\d+\)|download)/i.test(b.relativePath) ? 1 : 0;
    if (aNoise !== bNoise) {
        return aNoise - bNoise;
    }

    if (b.size !== a.size) {
        return b.size - a.size;
    }
    return a.relativePath.localeCompare(b.relativePath);
}

function sanitizeFilePart(value, maximumLength = 180) {
    const cleaned = normalizeWhitespace(value)
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
        .replace(/\.+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || 'Unknown').slice(0, maximumLength).trim();
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function shortStableId(prefix, value) {
    return `${prefix}_${crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)}`;
}

function stableHash(value) {
    return crypto.createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(value))
        .digest('hex');
}

function contributorNames(author) {
    const normalized = normalizeWhitespace(author)
        .replace(/\((?:ed|eds|editor|editors)\.?\)/gi, ' ')
        .replace(/\b(?:ed|eds|editor|editors)\.?$/gi, ' ')
        .replace(/\bet\s+al\.?\b/gi, ' ')
        .trim();
    if (!normalized) return [];

    const hasExplicitSeparator = /\s+(?:and|a|&|et)\s+|;/i.test(normalized);
    const coarseParts = normalized.split(/\s+(?:and|a|&|et)\s+|;/i).map(normalizeWhitespace).filter(Boolean);
    const contributors = coarseParts.flatMap(part => {
        const commaParts = part.split(/\s*,\s*/).map(normalizeWhitespace).filter(Boolean);
        if (commaParts.length >= 3) return commaParts;
        if (commaParts.length !== 2 || !hasExplicitSeparator) return [part];
        const [left, right] = commaParts;
        const leftWords = left.split(/\s+/).length;
        const rightWords = right.split(/\s+/).length;
        // "Surname, Given" is one surname-first contributor. In contrast, a
        // comma followed by an explicit conjunction can separate contributors.
        return leftWords === 1 && rightWords <= 2 ? [part] : commaParts;
    });
    return contributors.filter(Boolean);
}

function contributorKey(name) {
    const commaParts = normalizeWhitespace(name).split(/\s*,\s*/).filter(Boolean);
    const normalizedName = commaParts.length === 2 && commaParts[0].split(/\s+/).length <= 3
        ? `${commaParts[1]} ${commaParts[0]}`
        : name;
    return asciiKey(normalizedName);
}

function contributorKeys(author) {
    return [...new Set(contributorNames(author).map(contributorKey).filter(Boolean))];
}

function leadCreatorKey(author) {
    return contributorKeys(author)[0] || 'unknown';
}

async function mapLimit(values, limit, mapper) {
    const results = new Array(values.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= values.length) {
                return;
            }
            results[index] = await mapper(values[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, values.length || 1)) }, worker));
    return results;
}

module.exports = {
    asciiKey,
    cleanTitleHint,
    compareSourceVariants,
    config,
    configPath,
    contributorKeys,
    ensureDirectory,
    mapLimit,
    leadCreatorKey,
    normalizeWhitespace,
    outputRoot,
    parseNameHints,
    projectRoot,
    readJsonIfExists,
    removeEditionNoise,
    resolveProjectPath,
    sanitizeFilePart,
    sha256File,
    shortStableId,
    stableHash,
    workHintKey,
    writeJsonAtomic,
    writeJsonAtomicIfChanged,
    writeJsonLinesAtomic
};

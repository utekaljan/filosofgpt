const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { parseEpub } = require('epub2md');
const { projectRoot } = require('../../lib/corpus-pipeline');
const {
    conversionStackId,
    conversionVersion,
    converters,
    requireDoclingPythonPath
} = require('../../lib/converter-stack');
const { countTokens } = require('../../lib/token-counter');
const { progressLog, ProgressTracker } = require('../../lib/progress');

function resolveConfiguredPath(environmentName, fallback) {
    const configured = process.env[environmentName];
    if (!configured) {
        return path.join(projectRoot, fallback);
    }
    return path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
}

const inputFolder = resolveConfiguredPath('BOOKS_INPUT_DIR', 'output/books');
const outputFolder = resolveConfiguredPath('MARKDOWN_OUTPUT_DIR', 'output/markdown');
const tempFolder = resolveConfiguredPath('CONVERSION_TEMP_DIR', 'output/temp/conversion');
const errorLogFile = resolveConfiguredPath('CONVERSION_ERROR_LOG', 'output/reports/standalone/conversion-errors.log');
const reportFile = resolveConfiguredPath('CONVERSION_REPORT', 'output/reports/standalone/conversion.json');
const cleanConversion = process.env.CONVERSION_CLEAN === '1';
const resumeConversion = !cleanConversion && process.env.CONVERSION_RESUME !== '0';

const sourcePriority = ['.md', '.epub', '.pdf'];
const failedFiles = [];
const conversionReport = [];
const doclingWorkerScript = path.join(__dirname, 'docling-worker.py');

function fatalConverterError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.fatalConverterError = true;
    return error;
}

class DoclingWorker {
    constructor() {
        this.child = null;
        this.reader = null;
        this.pending = new Map();
        this.nextId = 1;
        this.shutdownAcknowledged = false;
        this.exitPromise = null;
        this.fatalError = null;
    }

    start() {
        if (this.child) return;
        const pythonPath = requireDoclingPythonPath();
        const cacheRoot = path.join(projectRoot, 'output', 'tools', 'cache');
        fs.mkdirSync(cacheRoot, { recursive: true });
        progressLog('convert:pdf', `starting persistent ${converters.pdf.name} ${converters.pdf.version} worker`);
        this.child = spawn(pythonPath, [doclingWorkerScript], {
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                HF_HOME: path.join(cacheRoot, 'huggingface'),
                TORCH_HOME: path.join(cacheRoot, 'torch')
            }
        });
        this.reader = readline.createInterface({ input: this.child.stdout });
        this.reader.on('line', line => this.handleLine(line));
        this.child.stderr.on('data', chunk => process.stderr.write(chunk));
        this.child.on('error', error => {
            this.markFatal(fatalConverterError('Unable to start the Docling worker.', error));
        });
        this.child.stdin.on('error', error => {
            if (this.shutdownAcknowledged) return;
            this.markFatal(fatalConverterError('Unable to communicate with the Docling worker.', error));
        });
        this.exitPromise = new Promise(resolve => {
            this.child.on('close', (code, signal) => {
                const detail = signal ? `signal ${signal}` : `exit ${code}`;
                if (!this.shutdownAcknowledged || code !== 0) {
                    this.markFatal(fatalConverterError(`Docling worker stopped unexpectedly (${detail}).`));
                }
                this.reader?.close();
                resolve({ code, signal });
            });
        });
    }

    handleLine(line) {
        let response;
        try {
            response = JSON.parse(line);
        } catch {
            this.markFatal(fatalConverterError(`Docling worker emitted invalid protocol output: ${line.slice(0, 500)}`));
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending) {
            this.markFatal(fatalConverterError(
                `Docling worker responded with unknown request id ${JSON.stringify(response.id)}.`
            ));
            return;
        }
        if (response.doclingVersion !== converters.pdf.version) {
            this.markFatal(fatalConverterError(
                `Expected Docling ${converters.pdf.version}, worker reported ${response.doclingVersion || 'no version'}.`
            ));
            return;
        }
        if (pending.shutdown && (!response.ok || response.shutdown !== true)) {
            this.markFatal(fatalConverterError('Docling worker did not acknowledge the shutdown request.'));
            return;
        }
        if (pending.shutdown) this.shutdownAcknowledged = true;
        this.pending.delete(response.id);
        if (response.ok) pending.resolve(response);
        else pending.reject(new Error(response.error || 'Docling conversion failed.'));
    }

    rejectPending(error) {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }

    markFatal(error) {
        if (!this.fatalError) this.fatalError = error;
        this.rejectPending(this.fatalError);
    }

    request(payload, options = {}) {
        if (this.fatalError) return Promise.reject(this.fatalError);
        this.start();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, shutdown: options.shutdown === true });
            this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
                if (!error) return;
                const fatalError = fatalConverterError('Unable to send a request to the Docling worker.', error);
                this.markFatal(fatalError);
                reject(fatalError);
            });
        });
    }

    convert(inputPath, outputPath) {
        return this.request({ input: inputPath, output: outputPath });
    }

    async close() {
        if (!this.child) {
            if (this.fatalError) throw this.fatalError;
            return;
        }
        if (!this.fatalError && this.child.exitCode === null && this.child.signalCode === null) {
            try {
                await this.request({ command: 'shutdown' }, { shutdown: true });
            } catch (error) {
                if (!this.fatalError) {
                    this.markFatal(fatalConverterError('Unable to shut down the Docling worker cleanly.', error));
                }
            }
        }
        if (
            this.fatalError &&
            this.child.exitCode === null &&
            this.child.signalCode === null &&
            !this.child.stdin.destroyed
        ) {
            this.child.stdin.end();
        }
        await this.exitPromise;
        this.child = null;
        if (this.fatalError) throw this.fatalError;
    }
}

function ensureCleanOutputFolder() {
    fs.mkdirSync(outputFolder, { recursive: true });
    fs.mkdirSync(tempFolder, { recursive: true });

    if (cleanConversion) {
        for (const entry of fs.readdirSync(outputFolder, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                fs.rmSync(path.join(outputFolder, entry.name), { force: true });
            }
        }
    }

    for (const entry of fs.readdirSync(tempFolder, { withFileTypes: true })) {
        fs.rmSync(path.join(tempFolder, entry.name), { recursive: true, force: true });
    }

    fs.mkdirSync(path.dirname(errorLogFile), { recursive: true });
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.rmSync(errorLogFile, { force: true });
    if (cleanConversion) {
        fs.rmSync(reportFile, { force: true });
    }
}

function persistConversionReport() {
    const temporaryPath = `${reportFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(conversionReport, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, reportFile);
}

function recordConversionReport(entry) {
    const existingIndex = conversionReport.findIndex(existing => (
        existing.baseName === entry.baseName && existing.sourcePath === entry.sourcePath
    ));
    if (existingIndex === -1) {
        conversionReport.push(entry);
    } else {
        conversionReport[existingIndex] = entry;
    }
    persistConversionReport();
}

function loadExistingConversionReport() {
    if (!resumeConversion || !fs.existsSync(reportFile)) {
        return;
    }
    try {
        const existing = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        if (Array.isArray(existing)) {
            conversionReport.push(...existing);
        }
    } catch (error) {
        console.warn(`Ignoring unreadable existing conversion report: ${error.message}`);
    }
}

function normalizeNewlines(text) {
    return text.replace(/\r\n?/g, '\n');
}

function normalizeMarkdown(text) {
    const normalized = replaceKnownMojibake(normalizeNewlines(text))
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/^\n+/, '')
        .trimEnd();
    return normalized ? `${normalized}\n` : '';
}

function replaceKnownMojibake(text) {
    const replacements = [
        ['\u00e2\u20ac\u2122', "'"],
        ['\u00e2\u20ac\u02dc', "'"],
        ['\u00e2\u20ac\u0153', '"'],
        ['\u00e2\u20ac\u009d', '"'],
        ['\u00e2\u20ac\u0165', '"'],
        ['\u00e2\u20ac\u00a6', '...'],
        ['\u00e2\u20ac\u201d', ' - '],
        ['\u00e2\u20ac\u201c', ' - '],
        ['\u00e2\u20ac\u201d', ' - '],
        ['\u00e2\u20ac\u00a2', ' - '],
        ['\u00e2\u201e\u00a2', '™'],
        ['\u00c2\u00a9', '©'],
        ['\u00c2\u00ae', '®'],
        ['\u00c2', ''],
        ['\u00a0', ' ']
    ];

    let fixed = text;
    for (const [from, to] of replacements) {
        fixed = fixed.split(from).join(to);
    }
    return fixed;
}

function removeXmlDeclarations(text) {
    return text.replace(/<\?xml[^>]*\?>\s*/gi, '');
}

function removeDocTypes(text) {
    return text.replace(/<!DOCTYPE[^>]*>\s*/gi, '');
}

function removeHtmlImages(text) {
    return text.replace(/<img\b[^>]*>/gi, '');
}

function removeMarkdownImages(text) {
    return text.replace(/!\[[^\]]*]\([^)]+\)/g, '');
}

function unwrapMarkdownLinks(text) {
    return text.replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1');
}

function removeHtmlTags(text) {
    return text.replace(/<\/?(?:div|span|section|article|body|html)[^>]*>/gi, '');
}

function removeControlCharacters(text) {
    return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function removeHtmlComments(text) {
    return text.replace(/<!--[\s\S]*?-->/g, '');
}

function simplifyMarkdownFormatting(text) {
    return text
        .replace(/(\*\*|__)([^*\n_][^\n]*?)(\1)/g, '$2')
        .replace(/(^|[^\*])\*([^*\n]+?)\*(?!\*)/g, '$1$2')
        .replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1$2')
        .replace(/\\([[\]().])/g, '$1');
}

function normalizeSpacing(text) {
    return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.;:!?])/g, '$1')
        .trim();
}

function cleanupText(text) {
    let cleaned = normalizeNewlines(text);
    cleaned = replaceKnownMojibake(cleaned);
    cleaned = removeXmlDeclarations(cleaned);
    cleaned = removeDocTypes(cleaned);
    cleaned = removeHtmlImages(cleaned);
    cleaned = removeMarkdownImages(cleaned);
    cleaned = unwrapMarkdownLinks(cleaned);
    cleaned = removeHtmlComments(cleaned);
    cleaned = removeHtmlTags(cleaned);
    cleaned = removeControlCharacters(cleaned);
    cleaned = simplifyMarkdownFormatting(cleaned);
    cleaned = normalizeSpacing(cleaned);
    return cleaned;
}

function countWords(text) {
    const matches = text.trim().match(/\S+/g);
    return matches ? matches.length : 0;
}

function countOccurrences(text, pattern) {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

function removeBibliography(text) {
    const patterns = [
        '## References',
        '## Bibliography',
        '## Sources',
        '## Further Reading',
        '## Works Cited'
    ];

    let lastIndex = -1;
    for (const pattern of patterns) {
        const index = text.lastIndexOf(pattern);
        if (index > lastIndex) {
            lastIndex = index;
        }
    }

    if (lastIndex === -1) {
        return text;
    }

    const trailingText = text.slice(lastIndex);
    return countWords(trailingText) <= 250 ? text.slice(0, lastIndex).trim() : text;
}

function trimInlineLeadingFrontmatter(text) {
    const titleHeader = text.match(/^# .+\n\n/)?.[0] || '';
    const searchLimit = Math.floor(text.length * 0.2);
    const leading = text.slice(0, searchLimit);
    const pattern = /\bINTRODUCTION\b(?:(?!\bPage\s+(?:[ivxlcdm]+|\d+)\b)[\s\S]){0,300}\bPage\s+(?:[ivxlcdm]+|\d+)\b/g;
    let match = pattern.exec(leading);
    let chosen = null;
    while (match) {
        chosen = match;
        match = pattern.exec(leading);
    }
    if (!chosen || chosen.index < 100) {
        return text;
    }
    const prefix = leading.slice(0, chosen.index);
    if (!/\b(?:contents|copyright|all rights reserved|isbn|acknowledg?ments|title page|series editor)\b/i.test(prefix)) {
        return text;
    }
    return `${titleHeader}${text.slice(chosen.index).trim()}`;
}

function trimInlineTrailingEndmatter(text) {
    const minimumIndex = Math.floor(text.length * 0.65);
    let cutIndex = text.length;
    const hardPattern = /\bPage\s+\d+\s+(?:BIBLIOGRAPHY|REFERENCES|WORKS CITED|FURTHER READING|INDEX)\b/g;
    let hardMatch = hardPattern.exec(text);
    while (hardMatch) {
        if (hardMatch.index >= minimumIndex && hardMatch.index < cutIndex) {
            cutIndex = hardMatch.index;
        }
        hardMatch = hardPattern.exec(text);
    }

    const headingPattern = /(?:^|\n)(?:#{1,6}\s*)?(?:bibliography|references|works cited|further reading)\s*(?:\n|$)/gim;
    let lastHeadingIndex = -1;
    let headingMatch = headingPattern.exec(text);
    while (headingMatch) {
        if (headingMatch.index >= minimumIndex) {
            lastHeadingIndex = headingMatch.index;
        }
        headingMatch = headingPattern.exec(text);
    }
    if (lastHeadingIndex >= 0) {
        cutIndex = Math.min(cutIndex, lastHeadingIndex);
    }
    return cutIndex < text.length ? text.slice(0, cutIndex).trim() : text;
}

function finalizeConvertedText(text) {
    let finalized = cleanupText(text);
    finalized = trimInlineLeadingFrontmatter(finalized);
    finalized = trimInlineTrailingEndmatter(finalized);
    finalized = removeBibliography(finalized);
    return normalizeSpacing(finalized);
}

function buildTextMetrics(text) {
    const tokens = countTokens(text);
    return {
        bytes: Buffer.byteLength(text, 'utf8'),
        characters: text.length,
        words: countWords(text),
        tokenCount: tokens.tokens,
        tokenCounts: tokens.byEncoding,
        pageMarkers: countOccurrences(text, /^## Page \d+$/gm),
        sectionMarkers: countOccurrences(text, /^## Section \d+$/gm),
        mojibakeSignals: countOccurrences(text, /\u00e2|\u00c2|\uFFFD/g),
        urls: countOccurrences(text, /https?:\/\/\S+/g)
    };
}

function splitHeadingAndBody(blockText) {
    const normalized = normalizeNewlines(blockText);
    const separatorIndex = normalized.indexOf('\n\n');

    if (separatorIndex === -1) {
        return {
            heading: normalized.trim(),
            body: ''
        };
    }

    return {
        heading: normalized.slice(0, separatorIndex).trim(),
        body: normalized.slice(separatorIndex + 2).trim()
    };
}

function getFirstContentLine(text) {
    const lines = normalizeNewlines(text)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    return lines[0] || '';
}

function hasContentStartSignal(text) {
    const firstLine = getFirstContentLine(text);
    if (/\b([ivxlcdm]+|\d+)\s*$/i.test(firstLine)) {
        return false;
    }

    return /^(introduction|preface|prologue|foreword|chapter\s+(1|one)\b|book\s+(1|one)\b|part\s+(1|one)\b|section\s+(1|one)\b)/i.test(firstLine);
}

function isLikelyAuthorBioFrontmatter(bodyText) {
    const normalized = bodyText.toLowerCase();
    const patterns = [
        /\bwas born in\b/,
        /\bstudied at\b/,
        /\breceived .* doctorate\b/,
        /\bbooks include\b/,
        /\bis the author of\b/,
        /\bassociate professor\b/,
        /\bedited by\b/
    ];

    return patterns.filter(pattern => pattern.test(normalized)).length >= 2;
}

function isLikelyEpigraphFrontmatter(bodyText) {
    const lines = normalizeNewlines(bodyText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    const quoteLines = lines.filter(line => line.startsWith('>')).length;
    const wordCount = countWords(bodyText);
    const attributionLikeLine = lines.some(line => /^(?:[-—–]|â€”)\s*[A-Z]/.test(line));
    const mostlyShortLines = lines.length > 0 && lines.filter(line => line.length <= 120).length / lines.length > 0.7;

    return (
        (lines.length > 0 && quoteLines >= 2 && quoteLines / lines.length > 0.4 && wordCount < 180) ||
        (lines.length >= 2 && lines.length <= 10 && wordCount < 220 && attributionLikeLine && mostlyShortLines)
    );
}

function isLikelyListLikeBlock(bodyText) {
    const lines = normalizeNewlines(bodyText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return false;
    }

    const shortLines = lines.filter(line => line.length <= 40).length;
    return shortLines / lines.length > 0.45;
}

function isLikelyPublisherMetadataBlock(bodyText) {
    const normalized = bodyText.toLowerCase();
    const patterns = [
        /\bfirst (?:anchor|paperback|edition)\b/,
        /\bpublished in the united states\b/,
        /\boriginally published\b/,
        /\bmap of\b.*copyright/,
        /\bgrateful acknowledgement\b/,
        /\bthe library of congress has cataloged\b/,
        /\bcataloging[- ]in[- ]publication\b/,
        /\ba catalogue record for this title\b/,
        /\bprinted and bound\b/,
        /\bfor further information\b/,
        /\bvisit our website\b/
    ];

    return patterns.filter(pattern => pattern.test(normalized)).length >= 2;
}

function isLikelyMarketingBlock(bodyText) {
    const normalized = bodyText.toLowerCase();
    const patterns = [
        /\bwhat'?s next on\b/,
        /\byour reading list\b/,
        /\bdiscover your next great read\b/,
        /\bget personalized book picks\b/,
        /\bsign up now\b/,
        /\bavailable from routledge\b/,
        /\balso of interest in\b/,
        /\btitles by [a-z]/,
        /\babout the author\b/
    ];

    return patterns.some(pattern => pattern.test(normalized));
}

function isLikelyReferenceListBlock(bodyText) {
    const lines = normalizeNewlines(bodyText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length < 6) {
        return false;
    }

    const referenceLikeLines = lines.filter(line =>
        /^>/.test(line) ||
        /\bhttps?:\/\//i.test(line) ||
        /\b(journal|press|university|working paper|proceedings|review|vol\.|vol |pp?\.|ed\.|eds\.|trans\.)\b/i.test(line) ||
        /^\d+\./.test(line)
    ).length;

    return referenceLikeLines / lines.length > 0.45;
}

function isLikelyTableOfContentsBlock(bodyText) {
    const normalized = bodyText.toLowerCase();
    const lines = normalizeNewlines(bodyText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (!/\bcontents\b/.test(normalized) && !/^contents\b/i.test(lines[0] || '')) {
        return false;
    }

    const tocLikeLines = lines.filter(line =>
        /\b(contents|title page|copyright|dedication|epigraph|maps|illustrations|appendix|index)\b/i.test(line) ||
        /\d+\s*$/.test(line)
    ).length;

    return tocLikeLines >= 3;
}

function isLikelyMainTextBlock(bodyText) {
    const lines = normalizeNewlines(bodyText)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length === 0) {
        return false;
    }

    const wordCount = countWords(bodyText);
    if (wordCount < 80) {
        return false;
    }

    if (isFrontmatterBlock(bodyText) || isLikelyTableOfContentsBlock(bodyText) || isLikelyListLikeBlock(bodyText)) {
        return false;
    }

    const longLines = lines.filter(line => line.length >= 60).length;
    return longLines >= Math.max(2, Math.floor(lines.length * 0.3));
}

function isFrontmatterBlock(bodyText) {
    const normalized = bodyText.toLowerCase();
    const frontmatterPatterns = [
        /also by/,
        /praise for/,
        /all rights reserved/,
        /\backnowledg?ments\b/,
        /library of congress/,
        /\bcopyright\b/,
        /\bcontents\b/,
        /\bdedication\b/,
        /\bepigraph\b/,
        /\bcover\b/,
        /\btitle page\b/,
        /\bisbn\b/,
        /\bpublisher'?s note\b/,
        /\bpublished by\b/,
        /\bprinted in\b/,
        /\bthis page intentionally left blank\b/,
        /internet archive/,
        /created with hocr-to-epub/,
        /\blccn\b/,
        /\bcip\b/,
        /\babout the author\b/,
        /\balso available\b/,
        /\bpenguin classics\b/,
        /\bthe university of chicago press\b/
    ];

    return (
        frontmatterPatterns.some(pattern => pattern.test(normalized)) ||
        isLikelyPublisherMetadataBlock(bodyText) ||
        isLikelyTableOfContentsBlock(bodyText) ||
        isLikelyMarketingBlock(bodyText) ||
        isLikelyAuthorBioFrontmatter(bodyText) ||
        isLikelyEpigraphFrontmatter(bodyText)
    );
}

function isEndmatterBlock(bodyText) {
    const normalized = bodyText.toLowerCase();
    const endmatterPatterns = [
        /\bindex\b/,
        /\bendnotes\b/,
        /\bnotes\b/,
        /\bbibliography\b/,
        /\breferences\b/,
        /\bworks cited\b/,
        /\bfurther reading\b/,
        /\b(?:a note about|notes? (?:about|on)) sources\b/,
        /\bsources\b/,
        /\bconcordance\b/,
        /\billustrations\b/
    ];

    return endmatterPatterns.some(pattern => pattern.test(normalized));
}

function isHardEndmatterStart(bodyText) {
    const firstLine = getFirstContentLine(bodyText).replace(/^#{1,6}\s*/, '');
    return /^(index|bibliography|references|works cited|further reading|(?:a note about|notes? (?:about|on)) sources|sources|concordance|illustrations|acknowledg?ments|notes(?:\s+to)?)\b/i.test(firstLine);
}

function trimLeadingFrontmatterBlocks(blocks) {
    const firstContentIndex = blocks.findIndex((block, index) => {
        if (index > 30) {
            return false;
        }

        const { body } = splitHeadingAndBody(block);
        return hasContentStartSignal(body) || isLikelyMainTextBlock(body);
    });

    if (firstContentIndex > 0) {
        return blocks.slice(firstContentIndex);
    }

    const trimmed = [];
    let dropping = true;

    for (const block of blocks) {
        const { body } = splitHeadingAndBody(block);
        const bodyWordCount = countWords(body);
        const frontmatter = isFrontmatterBlock(body);
        const contentStart = hasContentStartSignal(body);
        const mainText = isLikelyMainTextBlock(body);

        if (dropping) {
            if (contentStart || mainText) {
                dropping = false;
                trimmed.push(block);
                continue;
            }

            if (frontmatter) {
                continue;
            }

            dropping = false;
        }

        trimmed.push(block);
    }

    return trimmed;
}

function trimTrailingEndmatterBlocks(blocks) {
    if (blocks.length === 0) {
        return blocks;
    }

    let cutIndex = blocks.length;
    const sustainedEndmatterAfter = startIndex => {
        const trailing = blocks.slice(startIndex);
        if (trailing.length < 4) {
            return true;
        }
        const matching = trailing.filter(block => {
            const { body } = splitHeadingAndBody(block);
            return (
                isHardEndmatterStart(body) ||
                isLikelyReferenceListBlock(body) ||
                (isEndmatterBlock(body) && isLikelyListLikeBlock(body)) ||
                isLikelyMarketingBlock(body)
            );
        }).length;
        return matching / trailing.length >= 0.55;
    };

    const scanStart = Math.max(0, Math.floor(blocks.length * 0.7));
    for (let index = scanStart; index < blocks.length; index++) {
        const { body } = splitHeadingAndBody(blocks[index]);
        const nearEnd = index >= Math.floor(blocks.length * 0.8);

        if (!nearEnd) {
            continue;
        }

        if (isHardEndmatterStart(body) && (index >= blocks.length - 35 || sustainedEndmatterAfter(index))) {
            cutIndex = index;
            break;
        }

        if (isLikelyMarketingBlock(body)) {
            cutIndex = index;
            break;
        }

        if (isEndmatterBlock(body) && (isLikelyListLikeBlock(body) || isLikelyReferenceListBlock(body)) && sustainedEndmatterAfter(index)) {
            cutIndex = index;
            break;
        }

        if (isLikelyReferenceListBlock(body) && sustainedEndmatterAfter(index)) {
            cutIndex = index;
            break;
        }
    }

    if (cutIndex < blocks.length) {
        return blocks.slice(0, cutIndex);
    }

    return blocks;
}

function writeMarkdownOutput(baseName, text, metadata) {
    const outputFilePath = path.join(outputFolder, `${baseName}.md`);
    const outputText = text.trimEnd() ? `${text.trimEnd()}\n` : '';
    fs.writeFileSync(outputFilePath, outputText, 'utf8');

    const metrics = buildTextMetrics(outputText);
    const sourceStat = metadata.sourcePath && fs.existsSync(metadata.sourcePath)
        ? fs.statSync(metadata.sourcePath)
        : null;
    recordConversionReport({
        baseName,
        outputFile: outputFilePath,
        conversionVersion,
        conversionStackId,
        ...metadata,
        sourceSize: sourceStat?.size,
        sourceMtimeMs: sourceStat?.mtimeMs,
        metrics
    });

    console.log(
        `Saved ${metadata.sourceType.toUpperCase()}: ${path.basename(outputFilePath)} ` +
        `(${metrics.words} words, ${metrics.tokenCount} tokens, ${(metrics.bytes / 1024 / 1024).toFixed(2)} MB)`
    );
}

function recordFailedConversion(baseName, sourcePath, sourceType, error, converter) {
    const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const message = error instanceof Error ? error.message : String(error);
    recordConversionReport({
        baseName,
        sourceType,
        sourcePath,
        sourceSize: sourceStat?.size,
        sourceMtimeMs: sourceStat?.mtimeMs,
        conversionVersion,
        conversionStackId,
        converter,
        failed: true,
        error: message
    });
    return message;
}

function copyMarkdown(mdPath, baseName) {
    console.log(`Copying MD: ${mdPath}`);

    try {
        const markdownText = normalizeMarkdown(fs.readFileSync(mdPath, 'utf8'));
        writeMarkdownOutput(baseName, markdownText, {
            sourceType: 'md',
            sourcePath: mdPath
        });
        return true;
    } catch (error) {
        const message = recordFailedConversion(baseName, mdPath, 'md', error);
        failedFiles.push(`MD: ${mdPath} - ${message}`);
        return false;
    }
}

function getSectionMarkdown(section) {
    if (!section || typeof section.toMarkdown !== 'function') {
        return '';
    }

    try {
        return section.toMarkdown();
    } catch {
        return '';
    }
}

function epubMetadataText(value) {
    if (Array.isArray(value)) {
        return value.map(epubMetadataText).filter(Boolean).join(', ');
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    if (value && typeof value === 'object' && '_' in value) {
        return epubMetadataText(value._);
    }
    return '';
}

async function tryConvertEpubWithLibrary(epubPath, baseName) {
    const epubObj = await parseEpub(epubPath);
    const metadata = epubObj?.structure?.opf?.metadata || epubObj?.info || {};
    const title = epubMetadataText(metadata.title) || baseName;
    const author = epubMetadataText(metadata.author ?? metadata.creator);

    const sections = Array.isArray(epubObj?.sections) ? epubObj.sections : [];
    const renderedSections = sections
        .map((section, index) => {
            const markdown = cleanupText(getSectionMarkdown(section));
            if (countWords(markdown) < 10) {
                return '';
            }

            return `## Section ${index + 1}\n\n${markdown}`;
        })
        .filter(Boolean);

    const trimmedSections = trimTrailingEndmatterBlocks(trimLeadingFrontmatterBlocks(renderedSections));

    let markdownText = `# ${cleanupText(title)}\n\n`;
    if (author) {
        markdownText += `## Author: ${cleanupText(author)}\n\n`;
    }
    markdownText += trimmedSections.join('\n\n');

    return {
        sourceType: 'epub',
        sectionCount: trimmedSections.length,
        markdownText: finalizeConvertedText(markdownText)
    };
}

async function convertEpub(epubPath, baseName) {
    console.log(`Processing EPUB: ${epubPath}`);

    try {
        const parsed = await tryConvertEpubWithLibrary(epubPath, baseName);
        if (countWords(parsed.markdownText) < 10) {
            throw new Error('epub2md output contains fewer than 10 words.');
        }
        writeMarkdownOutput(baseName, parsed.markdownText, {
            sourceType: parsed.sourceType,
            sourcePath: epubPath,
            sectionCount: parsed.sectionCount,
            converter: converters.epub
        });
        return true;
    } catch (error) {
        const message = recordFailedConversion(baseName, epubPath, 'epub', error, converters.epub);
        failedFiles.push(`EPUB: ${epubPath} - ${message}`);
        return false;
    }
}

async function convertPdf(pdfPath, baseName, worker) {
    console.log(`Processing PDF: ${pdfPath}`);
    const rawOutputName = `docling-${crypto.createHash('sha256').update(pdfPath).digest('hex').slice(0, 20)}.md`;
    const rawOutputPath = path.join(tempFolder, rawOutputName);

    try {
        const workerMetrics = await worker.convert(pdfPath, rawOutputPath);
        if (workerMetrics.doclingVersion !== converters.pdf.version) {
            throw fatalConverterError(
                `Expected Docling ${converters.pdf.version}, worker reported ${workerMetrics.doclingVersion}.`
            );
        }
        const rawMarkdown = fs.readFileSync(rawOutputPath, 'utf8');
        let markdownText = `# ${baseName}\n\n${rawMarkdown}`;
        markdownText = finalizeConvertedText(markdownText);
        if (countWords(markdownText) < 10) {
            throw new Error('Docling output contains fewer than 10 words.');
        }

        writeMarkdownOutput(baseName, markdownText, {
            sourceType: 'pdf',
            sourcePath: pdfPath,
            pageCount: countOccurrences(markdownText, /^## Page \d+$/gm),
            sourcePageCount: workerMetrics.sourcePageCount,
            convertedPageCount: workerMetrics.convertedPageCount,
            converterElapsedSeconds: workerMetrics.elapsedSeconds,
            converter: converters.pdf
        });
        return true;
    } catch (error) {
        if (error?.fatalConverterError) throw error;
        const message = recordFailedConversion(baseName, pdfPath, 'pdf', error, converters.pdf);
        failedFiles.push(`PDF: ${pdfPath} - ${message}`);
        return false;
    }
}

function listInputFiles() {
    return fs.readdirSync(inputFolder)
        .map(name => {
            const filePath = path.join(inputFolder, name);
            const stat = fs.statSync(filePath);
            return {
                name,
                filePath,
                isFile: stat.isFile(),
                extension: path.extname(name).toLowerCase(),
                baseName: path.basename(name, path.extname(name))
            };
        })
        .filter(entry => entry.isFile && sourcePriority.includes(entry.extension))
        .sort((a, b) => {
            const priorityDifference = sourcePriority.indexOf(a.extension) - sourcePriority.indexOf(b.extension);
            if (priorityDifference !== 0) {
                return priorityDifference;
            }
            return a.name.localeCompare(b.name);
        });
}

async function convertAllBooks() {
    const files = listInputFiles();
    if (files.some(file => file.extension === '.pdf')) {
        requireDoclingPythonPath();
    }
    ensureCleanOutputFolder();
    loadExistingConversionReport();

    const validBaseNames = new Set(files.map(file => file.baseName));
    const validSourceKeys = new Set(files.map(file => `${file.baseName}\u0000${file.filePath}`));
    let removedOrphanCount = 0;
    for (const entry of fs.readdirSync(outputFolder, { withFileTypes: true })) {
        if (
            entry.isFile() &&
            entry.name.toLowerCase().endsWith('.md') &&
            !validBaseNames.has(path.basename(entry.name, path.extname(entry.name)))
        ) {
            fs.rmSync(path.join(outputFolder, entry.name), { force: true });
            removedOrphanCount += 1;
        }
    }
    if (removedOrphanCount > 0) {
        progressLog('convert', `removed ${removedOrphanCount} orphaned outputs outside the current conversion frontier`);
    }
    for (let index = conversionReport.length - 1; index >= 0; index--) {
        const entry = conversionReport[index];
        if (!validSourceKeys.has(`${entry.baseName}\u0000${entry.sourcePath}`)) {
            conversionReport.splice(index, 1);
        }
    }
    persistConversionReport();
    const attemptedBaseNames = new Set();
    const processedBaseNames = new Set();
    const progress = new ProgressTracker({ scope: 'convert', total: files.length });
    const doclingWorker = new DoclingWorker();
    progressLog('convert', `${files.length} input files; resume=${resumeConversion}; clean=${cleanConversion}`);

    try {
        for (const [fileIndex, file] of files.entries()) {
            if (attemptedBaseNames.has(file.baseName)) {
                recordConversionReport({
                    baseName: file.baseName,
                    sourceType: file.extension.slice(1),
                    sourcePath: file.filePath,
                    conversionVersion,
                    conversionStackId,
                    skipped: true,
                    reason: 'Higher-priority source with the same base name was already selected; fallback is disabled.'
                });
                progress.advance(`SKIPPED ${fileIndex + 1}/${files.length} duplicate base name: ${file.name}`);
                continue;
            }

            const sourceStat = fs.statSync(file.filePath);
            const existing = conversionReport.find(entry => (
                entry.baseName === file.baseName &&
                entry.sourcePath === file.filePath &&
                !entry.skipped
            ));
            const existingOutput = path.join(outputFolder, `${file.baseName}.md`);
            if (
                resumeConversion &&
                existing &&
                !existing.failed &&
                existing.conversionVersion === conversionVersion &&
                existing.conversionStackId === conversionStackId &&
                existing.sourceSize === sourceStat.size &&
                Math.abs((existing.sourceMtimeMs || 0) - sourceStat.mtimeMs) < 1 &&
                fs.existsSync(existingOutput) &&
                fs.statSync(existingOutput).size > 0 &&
                fs.statSync(existingOutput).size === existing.metrics?.bytes
            ) {
                attemptedBaseNames.add(file.baseName);
                processedBaseNames.add(file.baseName);
                progress.advance(`REUSED ${fileIndex + 1}/${files.length} ${file.name}`);
                continue;
            }

            fs.rmSync(existingOutput, { force: true });
            attemptedBaseNames.add(file.baseName);
            const progressId = `convert-${fileIndex}`;
            progress.start(progressId, fileIndex + 1, `${file.extension.slice(1).toUpperCase()} ${file.name}`);
            let outcome = 'processed';
            let threw = false;
            try {
                if (file.extension === '.md') {
                    const succeeded = copyMarkdown(file.filePath, file.baseName);
                    outcome = succeeded ? 'converted' : 'failed';
                    if (succeeded) processedBaseNames.add(file.baseName);
                    continue;
                }

                if (file.extension === '.epub') {
                    const succeeded = await convertEpub(file.filePath, file.baseName);
                    outcome = succeeded ? 'converted' : 'failed';
                    if (succeeded) processedBaseNames.add(file.baseName);
                    continue;
                }

                if (file.extension === '.pdf') {
                    const succeeded = await convertPdf(file.filePath, file.baseName, doclingWorker);
                    outcome = succeeded ? 'converted' : 'failed';
                    if (succeeded) processedBaseNames.add(file.baseName);
                }
            } catch (error) {
                threw = true;
                progress.fail(progressId, error);
                throw error;
            } finally {
                if (!threw) progress.complete(progressId, outcome);
            }
        }
    } finally {
        progress.dispose();
        await doclingWorker.close();
    }

    persistConversionReport();

    if (failedFiles.length > 0) {
        fs.writeFileSync(errorLogFile, failedFiles.join('\n') + '\n', 'utf8');
        failedFiles.forEach(message => console.error(message));
        progressLog(
            'convert',
            `complete: ${processedBaseNames.size} unique books; failures=${failedFiles.length}; failed sources omitted`
        );
        console.log(`Conversion report saved: ${reportFile}`);
        return;
    }

    progressLog('convert', `complete: ${processedBaseNames.size} unique books; failures=${failedFiles.length}`);
    console.log(`Conversion report saved: ${reportFile}`);
}

if (require.main === module) {
    convertAllBooks().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    convertAllBooks,
    normalizeMarkdown
};

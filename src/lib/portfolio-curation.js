'use strict';

const path = require('path');
const {
    config,
    contributorKeys,
    leadCreatorKey,
    normalizeWhitespace,
    stableHash
} = require('./corpus-pipeline');

// This is the complete public curation policy. It contains no imported private
// prompt, hidden rubric, source text, or credential.
const curationContractVersion = 5;

const corpusMissions = {
    FilosofGPT: [
        'FilosofGPT je především odborný partner pro filosofii mysli a vědomí, neurovědu, kognitivní vědu, fyziku a umělou inteligenci.',
        'Obecná filosofická klasika je důležitý základ, ale nesmí vytlačit jedinečné moderní zdroje přímo o vědomí, mozku, AI nebo základech fyziky.',
        'Politická filosofie patří při překryvu do PolyhistorGPT.'
    ].join(' '),
    PolyhistorGPT: [
        'PolyhistorGPT je odborný partner pro historii, ekonomii, geopolitiku, politickou filosofii, politickou teorii a dějiny institucí a idejí.',
        'Cílem je široká syntéza napříč epochami, regiony a přístupy; další dílo hojně zastoupeného autora nesmí automaticky vytlačit jediný kvalitní zdroj od jiného autora.'
    ].join(' ')
};

function sourceOrigin(work) {
    const relativePath = work.primarySource?.relativePath || '';
    const firstFolder = relativePath.split(/[\\/]/).filter(Boolean)[0] || '';
    const bundleLike = /\(\s*\d+\s+books?\b|ebooks?\s+of\b|complete\s+(?:works|collection)/i.test(firstFolder);
    return { firstFolder, bundleLike };
}

function groupWorksByCreator(works) {
    const groups = new Map();
    for (const work of works) {
        const creatorKey = leadCreatorKey(work.author);
        const entries = groups.get(creatorKey) || [];
        entries.push(work);
        groups.set(creatorKey, entries);
    }
    for (const entries of groups.values()) {
        entries.sort((a, b) => (
            b.priorityScore - a.priorityScore ||
            b.relevanceScore - a.relevanceScore ||
            a.title.localeCompare(b.title)
        ));
    }
    return groups;
}

function compactWork(work, creatorCount, summaryCharacters) {
    const origin = sourceOrigin(work);
    return {
        id: work.id,
        author: work.author,
        title: work.title,
        contentType: work.contentType,
        summaryCz: normalizeWhitespace(work.summaryCz).slice(0, summaryCharacters),
        intrinsicRelevance: work.relevanceScore,
        intrinsicPriority: work.priorityScore,
        creatorWorkCount: creatorCount,
        sourceVariantCount: work.sourceVariants?.length || 1,
        sourceOrigin: origin.firstFolder,
        bundleLikeOrigin: origin.bundleLike
    };
}

function buildAtlasPrompt(corpus, works) {
    const grouped = groupWorksByCreator(works);
    const roster = works.map(work => compactWork(
        work,
        grouped.get(leadCreatorKey(work.author))?.length || 1,
        config.curation.atlasSummaryCharacters
    ));
    const authorOverview = [...grouped.entries()].map(([authorKey, entries]) => ({
        authorKey,
        author: entries[0]?.author || authorKey,
        workCount: entries.length,
        bundleLikeCount: entries.filter(work => sourceOrigin(work).bundleLike).length,
        topTitles: entries.slice(0, 8).map(work => work.title)
    })).sort((a, b) => b.workCount - a.workCount || a.author.localeCompare(b.author));

    return [
        `Vytváříš jeden stabilní globální kurátorský atlas pro ${corpus}.`,
        'Neprovádíš finální výběr souborů ani fyzické slučování. Definuješ společné měřítko pro pozdější izolovaná volání a výslovně označíš jisté bibliografické duplicity a vztahy celek–část.',
        'Výstup musí přesně odpovídat JSON schématu a musí být česky.',
        'Všechny potřebné podklady jsou v promptu. Nepoužívej shell, lokální soubory, memory ani web.',
        '',
        'MISE',
        corpusMissions[corpus],
        '',
        'ZÁSADNÍ PRAVIDLA',
        '- Posuzuj portfolio jako celek. Priorita je relativní vůči ostatním dostupným dílům, ne izolované hodnocení reputace autora.',
        '- Vzácnost je přidaná hodnota: jediné relevantní dílo autora má obvykle vyšší mezní přínos než desáté podobné dílo hojně zastoupeného autora.',
        '- Vysoký creatorWorkCount nebo bundleLikeOrigin signalizuje možný hromadně získaný balík, nikoli automaticky vyšší hodnotu.',
        '- Pro FilosofGPT musí mít přímé moderní práce o vědomí, mozku a kognici přednost před nadbytečnými dalšími svazky obecné klasiky.',
        '- must_include_works používej střídmě pro nenahraditelné dostupné pilíře; uváděj jen existující work_id.',
        '- author_policies vytvoř zejména pro autory s většími balíky. soft_maximum je měkký limit před další silnou penalizací, ne zákaz.',
        '- exact_duplicate_groups je globální pojistka pro skutečně totéž původní dílo pod jiným překladem, edicí, názvem nebo variantou autora. Uveď všechny jisté případy, ale neslučuj svazky, části ani tematicky podobné knihy.',
        '- containment_relations zachycuje celek/část: Complete Works versus jednotlivé dílo, sbírka versus zařazený text, celý svazek versus výňatek. Nejde o absolutní bibliografickou duplicitu, ale o vzájemně výlučné varianty pro pozdější výběr. Úplně označ vztahy; deterministická fáze pak smí podle hodnoty a velikosti zvolit buď celek, nebo několik nepřekrývajících se důležitých částí.',
        '- Focus areas mají být dost široké a stabilní, aby se podle nich daly klasifikovat všechny knihy v pozdějších dávkách.',
        '',
        'KONTEXT KORPUSU',
        JSON.stringify({
            corpus,
            workCount: works.length,
            authorCount: grouped.size,
            authors: authorOverview,
            works: roster
        })
    ].join('\n');
}

function atlasWorkFingerprint(work) {
    return stableHash({
        id: work.id,
        author: normalizeWhitespace(work.author),
        title: normalizeWhitespace(work.title),
        contentType: work.contentType,
        summaryCz: normalizeWhitespace(work.summaryCz),
        relevanceScore: work.relevanceScore,
        priorityScore: work.priorityScore
    });
}

function buildAtlasBasis(corpus, works) {
    return {
        corpus,
        workCount: works.length,
        workFingerprints: Object.fromEntries([...works]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(work => [work.id, atlasWorkFingerprint(work)]))
    };
}

function atlasAdditionCompatibility(savedBasis, corpus, works) {
    if (!savedBasis || savedBasis.corpus !== corpus || !savedBasis.workFingerprints) {
        return { compatible: false, addedWorkIds: [] };
    }
    const currentBasis = buildAtlasBasis(corpus, works);
    const savedEntries = Object.entries(savedBasis.workFingerprints);
    const compatible = savedEntries.every(([id, fingerprint]) => (
        currentBasis.workFingerprints[id] === fingerprint
    ));
    if (!compatible || currentBasis.workCount < savedEntries.length) {
        return { compatible: false, addedWorkIds: [] };
    }
    return {
        compatible: true,
        addedWorkIds: Object.keys(currentBasis.workFingerprints)
            .filter(id => !savedBasis.workFingerprints[id])
            .sort(),
        currentBasis
    };
}

function validateAtlas(atlas, corpus, works, onWarning = () => {}) {
    if (!atlas || atlas.corpus !== corpus) throw new Error(`Atlas returned corpus ${atlas?.corpus}; expected ${corpus}.`);
    if (!Array.isArray(atlas.focus_areas) || atlas.focus_areas.length < 3) throw new Error('Atlas has too few focus areas.');
    const workById = new Map(works.map(work => [work.id, work]));
    const creatorKeys = new Set(works.flatMap(work => contributorKeys(work.author)));
    const focusKeys = atlas.focus_areas.map(area => area.key);
    if (new Set(focusKeys).size !== focusKeys.length) throw new Error('Atlas contains duplicate focus keys.');

    const warn = (code, message, details = {}) => onWarning({ code, message, ...details });

    atlas.must_include_works = (atlas.must_include_works || []).filter(item => {
        if (workById.has(item.work_id)) return true;
        warn('unknown_must_include_work', `Omitted unknown must-include work ${item.work_id}.`, { workId: item.work_id });
        return false;
    });

    atlas.author_policies = (atlas.author_policies || []).filter(policy => {
        if (!creatorKeys.has(policy.author_key)) {
            warn('unknown_author_policy', `Omitted policy for unknown author key ${policy.author_key}.`, { authorKey: policy.author_key });
            return false;
        }
        policy.preferred_work_ids = [...new Set(policy.preferred_work_ids || [])].filter(id => {
            const work = workById.get(id);
            if (!work) {
                warn('unknown_preferred_work', `Omitted unknown preferred work ${id} from ${policy.author_key}.`, {
                    authorKey: policy.author_key,
                    workId: id
                });
                return false;
            }
            if (!contributorKeys(work.author).includes(policy.author_key)) {
                warn('wrong_author_preferred_work', `Omitted preferred work ${id}; ${policy.author_key} is not one of its contributors.`, {
                    authorKey: policy.author_key,
                    workId: id
                });
                return false;
            }
            return true;
        });
        return true;
    });

    atlas.exact_duplicate_groups = (atlas.exact_duplicate_groups || []).filter(group => {
        const ids = [...new Set(group.work_ids || [])];
        const unknownIds = ids.filter(id => !workById.has(id));
        const invalid = (
            !workById.has(group.representative_work_id) ||
            unknownIds.length > 0 ||
            ids.length < 2 ||
            !ids.includes(group.representative_work_id)
        );
        if (!invalid) {
            group.work_ids = ids;
            return true;
        }
        warn('invalid_duplicate_group', `Omitted invalid duplicate group represented by ${group.representative_work_id}.`, {
            representativeWorkId: group.representative_work_id,
            unknownWorkIds: unknownIds
        });
        return false;
    });

    atlas.containment_relations = (atlas.containment_relations || []).filter(relation => {
        const unknown = !workById.has(relation.container_work_id) || !workById.has(relation.contained_work_id);
        const selfReferential = relation.container_work_id === relation.contained_work_id;
        if (!unknown && !selfReferential) return true;
        warn('invalid_containment_relation', `Omitted invalid containment relation ${relation.container_work_id} -> ${relation.contained_work_id}.`, {
            containerWorkId: relation.container_work_id,
            containedWorkId: relation.contained_work_id,
            reason: unknown ? 'unknown_work' : 'self_reference'
        });
        return false;
    });
    return atlas;
}

function buildCurationBatches(works, batchSize) {
    const groups = groupWorksByCreator(works);
    const units = [];
    for (const [creatorKey, roster] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        for (let offset = 0; offset < roster.length; offset += batchSize) {
            units.push({
                creatorKey,
                author: roster[0]?.author || creatorKey,
                roster,
                decisionWorks: roster.slice(offset, offset + batchSize)
            });
        }
    }
    const batches = [];
    let currentGroups = [];
    let currentCount = 0;
    const flush = () => {
        if (!currentGroups.length) return;
        batches.push({
            batchId: `curation-${String(batches.length + 1).padStart(4, '0')}`,
            groups: currentGroups,
            decisionWorks: currentGroups.flatMap(group => group.decisionWorks)
        });
        currentGroups = [];
        currentCount = 0;
    };
    for (const unit of units) {
        if (currentCount > 0 && currentCount + unit.decisionWorks.length > batchSize) flush();
        currentGroups.push(unit);
        currentCount += unit.decisionWorks.length;
        if (currentCount >= batchSize) flush();
    }
    flush();
    return batches;
}

function buildCurationPrompt(corpus, atlas, batch) {
    const decisionIds = new Set(batch.decisionWorks.map(work => work.id));
    const creatorGroups = batch.groups.map(group => ({
        creatorKey: group.creatorKey,
        author: group.author,
        authorWorkCount: group.roster.length,
        decisionWorkIds: group.decisionWorks.map(work => work.id),
        authorRoster: group.roster.map(work => compactWork(
            work,
            group.roster.length,
            config.curation.authorRosterSummaryCharacters
        ))
    }));
    return [
        `Kurátorsky posuzuješ část kompletního autorského portfolia pro ${corpus}. Batch ID je ${batch.batchId}.`,
        'Výstup musí přesně odpovídat JSON schématu, být česky a obsahovat právě jeden výsledek pro každý decisionWorkId.',
        'Všechny potřebné podklady jsou v promptu. Nepoužívej shell, lokální soubory, memory ani web.',
        '',
        'GLOBÁLNÍ SCHVÁLENÝ ATLAS',
        JSON.stringify(atlas),
        '',
        'PRAVIDLA IDENTITY A REDUNDANCE',
        '- canonical_work_id řeší absolutní totožnost díla napříč překladem, edicí a odlišným názvem. Všechna vydání téhož původního díla musí ukázat na jeden existující reprezentativní work_id z authorRoster; reprezentant ukazuje sám na sebe.',
        '- Různé svazky, části, kapitoly nebo samostatná díla NESLUČUJ jako totožná. Pro ně použij scope a contains_work_ids/contained_by_work_ids.',
        '- Collection nebo Complete Works může obsahovat jednotlivá díla. To je překryv, nikoliv absolutní duplicita.',
        '- Pro upload tvoří sbírka/celek a samostatně dostupné obsažené části vzájemně výlučné alternativy. Finální deterministický výběr smí dát přednost několika důležitým menším částem před nepřiměřeně velkým celkem. Proto vztahy contains/contained_by označ úplně a přesně.',
        '- edition_group_key může sdružovat překlady či vydání; identity_group_key označuje původní dílo. Používej stabilní ASCII-friendly klíče.',
        '- Vztahy smějí odkazovat jen na ID z authorRoster. Nehádej vztah pouze z podobnosti tématu.',
        '',
        'PRAVIDLA PORTFOLIA',
        '- comparative_priority je globálně kalibrovaná relativní hodnota vůči celému atlasu, ne izolovaný dojem z knihy. Škála je 0 až 100: 100 = nejvyšší priorita a nenahraditelnost, 0 = nulový mezní přínos.',
        '- author_rank je pořadí uvnitř CELÉHO authorRoster; nejlepší dílo autora má 1. Stejné pořadí neopakuj bez silného důvodu.',
        '- Jediné dílo vzácného autora může mít vysokou roli kvůli diverzifikaci. U velkého balíku musí každé další dílo obhájit mezní přínos.',
        '- essential/core používej jen pro skutečné pilíře cílové mise. specialized může být odborně kvalitní, ale úzké. redundant znamená zanedbatelný mezní přínos vzhledem k dostupným překryvům.',
        '- standalone_value vyjadřuje skutečnou samostatnou hodnotu části. Nesnižuj comparative_priority ani portfolio_role pouze proto, že existuje obsahující celek; obě varianty musí jít později férově porovnat podle hodnoty, překryvu a velikosti.',
        '- topic_keys používej pouze z atlasu.',
        '',
        'AUTORSKÝ KONTEXT',
        JSON.stringify({
            decisionWorkIds: [...decisionIds],
            creatorGroups
        })
    ].join('\n');
}

function validateCurationBatch(raw, atlas, batch) {
    if (!raw || raw.batch_id !== batch.batchId || !Array.isArray(raw.results)) {
        throw new Error(`Invalid curation response for ${batch.batchId}.`);
    }
    const expectedIds = batch.decisionWorks.map(work => work.id);
    const actualIds = raw.results.map(result => result.id);
    if (new Set(actualIds).size !== actualIds.length) throw new Error(`${batch.batchId} contains duplicate ids.`);
    const missing = expectedIds.filter(id => !actualIds.includes(id));
    const unexpected = actualIds.filter(id => !expectedIds.includes(id));
    if (missing.length || unexpected.length) throw new Error(`${batch.batchId} id mismatch; missing=${missing.join(',')} unexpected=${unexpected.join(',')}`);
    const groupByDecisionId = new Map(batch.groups.flatMap(group => (
        group.decisionWorks.map(work => [work.id, group])
    )));
    const topicKeys = new Set(atlas.focus_areas.map(area => area.key));
    const validationWarnings = [];
    const warn = (code, result, referencedValue, action) => validationWarnings.push({
        code,
        workId: result.id,
        referencedValue,
        action
    });
    for (const result of raw.results) {
        const group = groupByDecisionId.get(result.id);
        const rosterById = new Map(group.roster.map(work => [work.id, work]));
        if (normalizeWhitespace(result.identity_group_key).length < 3) {
            warn('empty_identity_group_key', result, result.identity_group_key, 'replaced_with_conservative_self_key');
            result.identity_group_key = `work-${result.id}`;
        }
        if (normalizeWhitespace(result.edition_group_key).length < 3) {
            warn('empty_edition_group_key', result, result.edition_group_key, 'replaced_with_conservative_self_key');
            result.edition_group_key = `edition-${result.id}`;
        }
        if (!rosterById.has(result.canonical_work_id)) {
            warn('unknown_canonical_work', result, result.canonical_work_id, 'replaced_with_self');
            result.canonical_work_id = result.id;
        }
        result.contains_work_ids = [...new Set(result.contains_work_ids)].filter(id => {
            const valid = rosterById.has(id) && id !== result.id;
            if (!valid) warn('invalid_contains_relation', result, id, 'omitted');
            return valid;
        });
        result.contained_by_work_ids = [...new Set(result.contained_by_work_ids)].filter(id => {
            const valid = rosterById.has(id) && id !== result.id;
            if (!valid) warn('invalid_contained_by_relation', result, id, 'omitted');
            return valid;
        });
        result.topic_keys = [...new Set(result.topic_keys)].filter(key => {
            const valid = topicKeys.has(key);
            if (!valid) warn('unknown_topic_key', result, key, 'omitted');
            return valid;
        });
    }
    return { results: raw.results, validationWarnings };
}

function curationInputHash(work, roster, atlasHash) {
    return stableHash({
        contractVersion: curationContractVersion,
        atlasHash,
        creatorRoster: roster.map(item => compactWork(item, roster.length, config.curation.authorRosterSummaryCharacters)),
        work: compactWork(work, roster.length, config.curation.authorRosterSummaryCharacters)
    });
}

function buildPortfolio(corpus, works, atlas, decisions) {
    const workById = new Map(works.map(work => [work.id, work]));
    const decisionById = new Map(decisions.map(decision => [decision.id, decision]));
    const groups = groupWorksByCreator(works);
    const mustInclude = new Map((atlas.must_include_works || []).map(item => [item.work_id, item.reason_cz]));
    const authorPolicies = new Map((atlas.author_policies || []).map(policy => [policy.author_key, policy]));
    const relationContains = new Map();
    const relationContainedBy = new Map();
    const parent = new Map(works.map(work => [work.id, work.id]));
    const find = id => {
        let current = id;
        while (parent.get(current) !== current) current = parent.get(current);
        let cursor = id;
        while (parent.get(cursor) !== cursor) {
            const next = parent.get(cursor);
            parent.set(cursor, current);
            cursor = next;
        }
        return current;
    };
    const union = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parent.set(b, a);
    };
    const identityKeys = new Map();
    for (const decision of decisions) {
        const work = workById.get(decision.id);
        const canonical = workById.get(decision.canonical_work_id);
        if (canonical && leadCreatorKey(work.author) === leadCreatorKey(canonical.author)) {
            union(decision.id, decision.canonical_work_id);
        }
        const identityKey = `${leadCreatorKey(work.author)}|${decision.identity_group_key}`;
        if (identityKeys.has(identityKey)) union(decision.id, identityKeys.get(identityKey));
        else identityKeys.set(identityKey, decision.id);
        for (const target of decision.contains_work_ids || []) {
            relationContains.set(decision.id, new Set([...(relationContains.get(decision.id) || []), target]));
            relationContainedBy.set(target, new Set([...(relationContainedBy.get(target) || []), decision.id]));
        }
        for (const containerId of decision.contained_by_work_ids || []) {
            relationContainedBy.set(decision.id, new Set([...(relationContainedBy.get(decision.id) || []), containerId]));
            relationContains.set(containerId, new Set([...(relationContains.get(containerId) || []), decision.id]));
        }
    }
    for (const duplicateGroup of atlas.exact_duplicate_groups || []) {
        const ids = duplicateGroup.work_ids.filter(id => workById.has(id));
        ids.slice(1).forEach(id => union(ids[0], id));
    }
    for (const relation of atlas.containment_relations || []) {
        relationContains.set(relation.container_work_id, new Set([
            ...(relationContains.get(relation.container_work_id) || []),
            relation.contained_work_id
        ]));
        relationContainedBy.set(relation.contained_work_id, new Set([
            ...(relationContainedBy.get(relation.contained_work_id) || []),
            relation.container_work_id
        ]));
    }
    const components = new Map();
    for (const work of works) {
        const root = find(work.id);
        components.set(root, [...(components.get(root) || []), work.id]);
    }
    const roleOrder = { essential: 6, core: 5, strong: 4, supporting: 3, specialized: 2, redundant: 1 };
    const canonicalMentions = new Map();
    decisions.forEach(decision => canonicalMentions.set(
        decision.canonical_work_id,
        (canonicalMentions.get(decision.canonical_work_id) || 0) + 1
    ));
    for (const group of atlas.exact_duplicate_groups || []) {
        canonicalMentions.set(
            group.representative_work_id,
            (canonicalMentions.get(group.representative_work_id) || 0) + group.work_ids.length
        );
    }
    const representativeById = new Map();
    for (const memberIds of components.values()) {
        const representative = [...memberIds].sort((leftId, rightId) => {
            const leftDecision = decisionById.get(leftId);
            const rightDecision = decisionById.get(rightId);
            const leftWork = workById.get(leftId);
            const rightWork = workById.get(rightId);
            const leftFormat = config.sourcePriority.indexOf(leftWork.primarySource?.extension || '');
            const rightFormat = config.sourcePriority.indexOf(rightWork.primarySource?.extension || '');
            return (
                (canonicalMentions.get(rightId) || 0) - (canonicalMentions.get(leftId) || 0) ||
                roleOrder[rightDecision.portfolio_role] - roleOrder[leftDecision.portfolio_role] ||
                rightDecision.comparative_priority - leftDecision.comparative_priority ||
                leftDecision.author_rank - rightDecision.author_rank ||
                (leftFormat < 0 ? 99 : leftFormat) - (rightFormat < 0 ? 99 : rightFormat) ||
                leftId.localeCompare(rightId)
            );
        })[0];
        memberIds.forEach(id => representativeById.set(id, representative));
    }
    const mustIncludeByRepresentative = new Map();
    for (const [workId, reason] of mustInclude.entries()) {
        const representative = representativeById.get(workId) || workId;
        const reasons = mustIncludeByRepresentative.get(representative) || [];
        reasons.push(reason);
        mustIncludeByRepresentative.set(representative, reasons);
    }
    const entries = works.map(work => {
        const decision = decisionById.get(work.id);
        if (!decision) throw new Error(`Missing curation decision for ${work.id}.`);
        const creatorKey = leadCreatorKey(work.author);
        const canonicalWorkId = representativeById.get(work.id) || work.id;
        const normalizedContains = [...(relationContains.get(work.id) || [])]
            .map(id => representativeById.get(id) || id)
            .filter(id => id !== canonicalWorkId);
        const normalizedContainedBy = [...(relationContainedBy.get(work.id) || [])]
            .map(id => representativeById.get(id) || id)
            .filter(id => id !== canonicalWorkId);
        const mustIncludeReasons = mustIncludeByRepresentative.get(canonicalWorkId) || [];
        return {
            workId: work.id,
            author: work.author,
            title: work.title,
            creatorKey,
            creatorWorkCount: groups.get(creatorKey)?.length || 1,
            bundleLikeOrigin: sourceOrigin(work).bundleLike,
            canonicalWorkId,
            exactDuplicate: canonicalWorkId !== work.id,
            identityGroupKey: decision.identity_group_key,
            editionGroupKey: decision.edition_group_key,
            scope: decision.scope,
            containsWorkIds: [...new Set(normalizedContains)].sort(),
            containedByWorkIds: [...new Set(normalizedContainedBy)].sort(),
            topicKeys: [...new Set(decision.topic_keys)].sort(),
            portfolioRole: decision.portfolio_role,
            comparativePriority: decision.comparative_priority,
            authorRank: decision.author_rank,
            standaloneValue: decision.standalone_value,
            mustInclude: mustIncludeReasons.length > 0,
            mustIncludeReasonCz: [...new Set(mustIncludeReasons)].join(' '),
            subsumedWorkIds: [],
            authorSoftMaximum: authorPolicies.get(creatorKey)?.soft_maximum || null,
            reasonCz: decision.reason_cz
        };
    });
    const representativeEntries = entries.filter(entry => !entry.exactDuplicate);
    const representativeEntryById = new Map(representativeEntries.map(entry => [entry.workId, entry]));
    for (const duplicate of entries.filter(entry => entry.exactDuplicate)) {
        const representative = representativeEntryById.get(duplicate.canonicalWorkId);
        if (!representative) continue;
        representative.containsWorkIds = [...new Set([
            ...representative.containsWorkIds,
            ...duplicate.containsWorkIds
        ])].sort();
        representative.containedByWorkIds = [...new Set([
            ...representative.containedByWorkIds,
            ...duplicate.containedByWorkIds
        ])].sort();
    }
    const visitState = new Map();
    const visitContainment = entry => {
        const state = visitState.get(entry.workId) || 0;
        if (state === 1) throw new Error(`Containment cycle detected at ${entry.workId}.`);
        if (state === 2) return;
        visitState.set(entry.workId, 1);
        for (const childId of entry.containsWorkIds) {
            const child = representativeEntryById.get(childId);
            if (child) visitContainment(child);
        }
        visitState.set(entry.workId, 2);
    };
    representativeEntries.forEach(visitContainment);

    // A container covers its descendants' topics and records that coverage,
    // but it does not inherit their priority, role or must-include status.
    // The final size-aware selector compares the whole against its parts.
    for (let pass = 0; pass < representativeEntries.length; pass++) {
        let changed = false;
        for (const child of representativeEntries) {
            for (const containerId of child.containedByWorkIds) {
                const container = representativeEntryById.get(containerId);
                if (!container) continue;
                const previous = JSON.stringify({
                    topics: container.topicKeys,
                    subsumed: container.subsumedWorkIds
                });
                container.topicKeys = [...new Set([...container.topicKeys, ...child.topicKeys])].sort();
                container.subsumedWorkIds = [...new Set([
                    ...container.subsumedWorkIds,
                    child.workId,
                    ...child.subsumedWorkIds
                ])].sort();
                const current = JSON.stringify({
                    topics: container.topicKeys,
                    subsumed: container.subsumedWorkIds
                });
                if (current !== previous) changed = true;
            }
        }
        if (!changed) break;
    }
    const duplicateGroups = [...new Map(entries.map(entry => [entry.canonicalWorkId, []])).keys()]
        .map(canonicalWorkId => ({
            canonicalWorkId,
            workIds: entries.filter(entry => entry.canonicalWorkId === canonicalWorkId).map(entry => entry.workId)
        }))
        .filter(group => group.workIds.length > 1);
    return {
        version: 1,
        contractVersion: curationContractVersion,
        generatedAt: new Date().toISOString(),
        corpus,
        atlas,
        atlasHash: stableHash(atlas),
        summary: {
            workCount: entries.length,
            exactDuplicateWorkCount: entries.filter(entry => entry.exactDuplicate).length,
            duplicateGroupCount: duplicateGroups.length,
            containmentRelationCount: entries.reduce((sum, entry) => sum + entry.containsWorkIds.length, 0),
            subsumedWorkCount: representativeEntries.filter(entry => entry.containedByWorkIds.length > 0).length,
            mustIncludeCount: entries.filter(entry => entry.mustInclude).length
        },
        duplicateGroups,
        works: entries
    };
}

module.exports = {
    atlasAdditionCompatibility,
    atlasWorkFingerprint,
    buildAtlasBasis,
    buildAtlasPrompt,
    buildCurationBatches,
    buildCurationPrompt,
    buildPortfolio,
    compactWork,
    corpusMissions,
    curationContractVersion,
    curationInputHash,
    groupWorksByCreator,
    sourceOrigin,
    validateAtlas,
    validateCurationBatch
};

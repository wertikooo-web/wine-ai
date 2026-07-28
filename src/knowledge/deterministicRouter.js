'use strict';

// Deterministic backend router — the backend component that AUTOMATICALLY
// triggers external search for mandatory cases, rather than relying on the
// LLM to decide. This is the "code-level enforcement" layer.
//
// Design:
// - Intercepts tool results from search_wine_knowledge and search_winery
// - When structured facts are missing, automatically triggers external lookup
// - For location/hours/contact intents, forces place search
// - For missing entity facts, triggers web search + page crawl + extraction
// - Stores discovered facts in entityFacts for future fast-path access
// - Returns enriched results to the LLM with provenance

const { getFact, getFacts, storeFact, hasFreshFact } = require('./entityFacts');
const { classifyQuery, requiredFactTypes, needsExternalSearch } = require('./intentRouter');
const { searchWeb, searchOfficialSite } = require('./webSearch');
const { searchPlace } = require('./placeSearch');
const { fetchAndExtract } = require('./pageCrawler');
const { globalCache } = require('./factCache');

const EXTERNAL_TIMEOUT_MS = 8000;

/**
 * Process a tool result through the deterministic router.
 * If the result is insufficient, automatically triggers external search.
 *
 * @param {string} toolName - The tool that was called (search_wine_knowledge, search_winery)
 * @param {object} toolResult - The result from the internal tool
 * @param {object} context - { query, activeEntity, activeEntityType, sessionMemory }
 * @returns {Promise<object>} Enriched result with external facts if needed
 */
async function processToolResult(toolName, toolResult, context = {}) {
    const { query = '', activeEntity = null, activeEntityType = null } = context;
    const startedAt = Date.now();

    // Classify the query to determine intent
    const classification = classifyQuery(query, { activeEntity, activeEntityType });

    // Log the routing decision
    const logEntry = {
        tool: toolName,
        query: query.slice(0, 100),
        subject: classification.subject,
        intent: classification.intent,
        route: classification.route,
        internalFound: toolResult?.found || false,
        activeEntity,
    };

    // If internal search found good results, check if we still need external facts
    if (toolResult?.found && toolResult.results?.length > 0) {
        // For scalar intents (address, phone, hours), check if structured facts exist
        const scalarIntents = ['locate', 'contact', 'hours', 'website', 'price', 'availability'];
        if (scalarIntents.includes(classification.intent) && activeEntity) {
            const requiredTypes = requiredFactTypes(classification.intent);
            const missingTypes = requiredTypes.filter((ft) => !hasFreshFact(activeEntity, ft));

            if (missingTypes.length > 0) {
                // Internal KB has results but structured facts are missing
                // Trigger external search for the missing structured data
                logEntry.reason = 'structured_facts_missing';
                logEntry.missingFactTypes = missingTypes;
                console.log('[deterministicRouter] enriching with external facts:', JSON.stringify(logEntry));

                const externalResult = await _fetchExternalFacts(activeEntity, classification.intent, missingTypes, query);
                return _mergeResults(toolResult, externalResult, classification);
            }
        }
        // Internal results are sufficient
        logEntry.decision = 'internal_sufficient';
        console.log('[deterministicRouter]', JSON.stringify(logEntry));
        return toolResult;
    }

    // Internal search did NOT find results — trigger external search
    logEntry.reason = 'internal_not_found';

    if (!query) {
        logEntry.decision = 'no_query';
        console.log('[deterministicRouter]', JSON.stringify(logEntry));
        return toolResult;
    }

    console.log('[deterministicRouter] triggering external search:', JSON.stringify(logEntry));

    // Determine entity name for external search
    const entityName = activeEntity || _extractEntityName(query);

    // Route to appropriate external search
    const externalResult = await _routeExternalSearch(entityName, query, classification);
    return _mergeResults(toolResult, externalResult, classification);
}

/**
 * Force external lookup for a specific entity + intent.
 * Used when the backend determines external search is mandatory.
 */
async function forceExternalLookup(entityName, intent, { timeoutMs = EXTERNAL_TIMEOUT_MS } = {}) {
    const requiredTypes = requiredFactTypes(intent);
    return _fetchExternalFacts(entityName, intent, requiredTypes, entityName);
}

// --- Internal routing ---

async function _routeExternalSearch(entityName, query, classification) {
    const results = { facts: [], sources: [], webResults: [] };
    const timeoutMs = EXTERNAL_TIMEOUT_MS;

    switch (classification.intent) {
        case 'locate':
        case 'hours': {
            // Place search for address/hours
            const placeResult = await searchPlace(entityName, { timeoutMs });
            if (placeResult.found && placeResult.places.length > 0) {
                const place = placeResult.places[0];
                results.facts.push(
                    { factType: 'address', value: place.formatted_address, source: 'maps_place_provider' },
                    { factType: 'latitude', value: place.latitude, source: 'maps_place_provider' },
                    { factType: 'longitude', value: place.longitude, source: 'maps_place_provider' },
                    { factType: 'city', value: place.address?.city, source: 'maps_place_provider' },
                    { factType: 'country', value: place.address?.country, source: 'maps_place_provider' }
                );
                if (place.opening_hours) {
                    results.facts.push({ factType: 'opening_hours', value: place.opening_hours, source: 'maps_place_provider' });
                }
                if (place.website) {
                    results.facts.push({ factType: 'official_website', value: place.website, source: 'maps_place_provider' });
                }
                if (place.phone) {
                    results.facts.push({ factType: 'phone', value: place.phone, source: 'maps_place_provider' });
                }
                results.sources.push({ url: `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(entityName)}`, type: 'maps_place_provider' });
            }
            // Also do a web search for official site
            const webResult = await searchOfficialSite(entityName, { timeoutMs });
            if (webResult.found) {
                results.webResults = webResult.results;
                // Try to crawl the top result for more facts
                const topOfficial = webResult.results.find((r) => r.is_official) || webResult.results[0];
                if (topOfficial?.url) {
                    const pageResult = await fetchAndExtract(topOfficial.url, { timeoutMs });
                    if (pageResult.found && pageResult.facts) {
                        for (const [factType, value] of Object.entries(pageResult.facts)) {
                            if (value && !results.facts.some((f) => f.factType === factType)) {
                                results.facts.push({ factType, value, source: 'official_website', sourceUrl: topOfficial.url });
                            }
                        }
                        results.sources.push({ url: topOfficial.url, type: 'official_website' });
                    }
                }
            }
            break;
        }
        case 'contact': {
            // Web search for contact info
            const webResult = await searchOfficialSite(entityName, { timeoutMs });
            if (webResult.found) {
                results.webResults = webResult.results;
                const topOfficial = webResult.results.find((r) => r.is_official) || webResult.results[0];
                if (topOfficial?.url) {
                    const pageResult = await fetchAndExtract(topOfficial.url, { timeoutMs });
                    if (pageResult.found && pageResult.facts) {
                        for (const [factType, value] of Object.entries(pageResult.facts)) {
                            if (value && !results.facts.some((f) => f.factType === factType)) {
                                results.facts.push({ factType, value, source: 'official_website', sourceUrl: topOfficial.url });
                            }
                        }
                        results.sources.push({ url: topOfficial.url, type: 'official_website' });
                    }
                }
            }
            break;
        }
        case 'price':
        case 'availability':
        case 'purchase': {
            // Commerce search — already handled by checkWineMdAvailability
            // Just do a web search as fallback
            const webResult = await searchWeb(`${entityName} buy price wine`, { timeoutMs });
            if (webResult.found) {
                results.webResults = webResult.results;
                results.sources.push(...webResult.results.map((r) => ({ url: r.url, type: 'general_web' })));
            }
            break;
        }
        default: {
            // General description or unknown intent — web search
            const webResult = await searchWeb(query, { timeoutMs });
            if (webResult.found) {
                results.webResults = webResult.results;
                results.sources.push(...webResult.results.map((r) => ({ url: r.url, type: 'general_web' })));
                // Try to extract facts from top result
                const topResult = webResult.results[0];
                if (topResult?.url) {
                    const pageResult = await fetchAndExtract(topResult.url, { timeoutMs });
                    if (pageResult.found && pageResult.facts) {
                        for (const [factType, value] of Object.entries(pageResult.facts)) {
                            if (value) results.facts.push({ factType, value, source: 'general_web', sourceUrl: topResult.url });
                        }
                        results.sources.push({ url: topResult.url, type: 'general_web' });
                    }
                }
            }
            break;
        }
    }

    // Store discovered facts in entity facts store
    if (entityName && results.facts.length > 0) {
        const entityId = _normalizeEntityId(entityName);
        for (const fact of results.facts) {
            if (fact.value) {
                storeFact(entityId, {
                    factType: fact.factType,
                    value: fact.value,
                    sourceUrl: fact.sourceUrl || null,
                    sourceType: fact.source === 'maps_place_provider' ? 'maps_place_provider' :
                                fact.source === 'official_website' ? 'official_website' : 'general_web',
                    confidence: fact.source === 'maps_place_provider' ? 'medium' : 'medium',
                });
                // Also cache
                globalCache.set(entityId, fact.factType, fact.value, 5 * 60 * 1000);
            }
        }
    }

    return results;
}

async function _fetchExternalFacts(entityId, intent, requiredTypes, query) {
    const results = { facts: [], sources: [] };
    const timeoutMs = EXTERNAL_TIMEOUT_MS;

    // For location/hours — use place search
    if (['locate', 'hours'].includes(intent)) {
        const placeResult = await searchPlace(entityId, { timeoutMs });
        if (placeResult.found && placeResult.places.length > 0) {
            const place = placeResult.places[0];
            results.facts.push(
                { factType: 'address', value: place.formatted_address },
                { factType: 'latitude', value: place.latitude },
                { factType: 'longitude', value: place.longitude }
            );
            if (place.opening_hours) results.facts.push({ factType: 'opening_hours', value: place.opening_hours });
            if (place.phone) results.facts.push({ factType: 'phone', value: place.phone });
            if (place.website) results.facts.push({ factType: 'official_website', value: place.website });
        }
    }

    // For contact — fetch official site
    if (['contact', 'website'].includes(intent)) {
        const webResult = await searchOfficialSite(entityId, { timeoutMs });
        if (webResult.found && webResult.results[0]?.url) {
            const pageResult = await fetchAndExtract(webResult.results[0].url, { timeoutMs });
            if (pageResult.facts) {
                for (const [ft, val] of Object.entries(pageResult.facts)) {
                    if (val && requiredTypes.includes(ft)) {
                        results.facts.push({ factType: ft, value: val, sourceUrl: webResult.results[0].url });
                    }
                }
            }
        }
    }

    // Store discovered facts
    for (const fact of results.facts) {
        if (fact.value) {
            storeFact(entityId, {
                factType: fact.factType,
                value: fact.value,
                sourceUrl: fact.sourceUrl || null,
                sourceType: 'official_website',
            });
        }
    }

    return results;
}

function _mergeResults(internalResult, externalResult, classification) {
    const merged = { ...internalResult };

    // Add external facts
    if (externalResult.facts && externalResult.facts.length > 0) {
        merged.externalFacts = externalResult.facts;
        merged.externalSources = externalResult.sources || [];
        merged.hasExternalData = true;
    }

    // Add web results
    if (externalResult.webResults && externalResult.webResults.length > 0) {
        merged.webResults = externalResult.webResults;
    }

    // Add instruction for the model
    if (merged.hasExternalData) {
        merged.instruction = `External data was found. Use the externalFacts to answer the user's question. Cite the source. Do not invent data — only use what is in externalFacts.`;
    } else if (!internalResult.found) {
        merged.instruction = `Neither internal knowledge base nor external search found relevant information. Tell the user honestly: "У меня нет подтверждённых данных об этом. Можете проверить официальный источник." Do NOT invent an answer.`;
    }

    return merged;
}

function _extractEntityName(query) {
    // Simple extraction: remove common question words, keep proper nouns
    return query
        .replace(/\b(расскажи|про|что|такое|где|находится|какой|какие|как|сколько|найди|найти|адрес|телефон|сайт|часы|работ)\b/gi, ' ')
        .replace(/[?!.,:;]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
}

function _normalizeEntityId(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100);
}

module.exports = {
    processToolResult,
    forceExternalLookup,
};

'use strict';

// Real place/location search tool — makes REAL network calls to Nominatim.
// Returns address, coordinates, opening hours, and website for physical locations.

const { searchPlace: searchPlaceProvider } = require('../knowledge/placeSearch');
const { requireNonEmptyString, optionalString } = require('./toolHelpers');

const declaration = {
    name: 'search_place',
    description: 'Search for a physical place (winery, wine shop, restaurant, tasting room) to get its address, coordinates, opening hours, phone, and website. Use this when the user asks about where something is located, its address, how to get there, opening hours, or contact details. Returns real geographic data from OpenStreetMap with source attribution.',
    parameters: {
        type: 'OBJECT',
        properties: {
            entity_name: {
                type: 'STRING',
                description: 'The name of the place to search for (e.g. "WineMD", "Purcari winery", "Cricova").',
            },
            city: {
                type: 'STRING',
                description: 'Optional city to narrow the search (e.g. "Chisinau").',
            },
            country: {
                type: 'STRING',
                description: 'Optional country (defaults to Moldova).',
            },
        },
        required: ['entity_name'],
    },
};

async function impl(args) {
    const entityName = requireNonEmptyString(args.entity_name, 'entity_name');
    const city = optionalString(args.city, 100) || null;
    const country = optionalString(args.country, 100) || null;

    const result = await searchPlaceProvider(entityName, { city, country });

    if (!result.found) {
        return {
            found: false,
            places: [],
            instruction: 'No place found. Do not invent an address — tell the user the location was not found in the geographic database.',
            tookMs: result.tookMs,
        };
    }

    return {
        found: true,
        places: result.places.map((p) => ({
            name: p.name,
            formatted_address: p.formatted_address,
            latitude: p.latitude,
            longitude: p.longitude,
            phone: p.phone,
            website: p.website,
            opening_hours: p.opening_hours,
            osm_id: p.osm_id,
            source_type: p.source_type,
            confidence: p.confidence,
            fetched_at: p.fetched_at,
        })),
        instruction: 'Use this place data to answer the user. Cite the source (OpenStreetMap/Nominatim). Only state facts that appear in these results.',
        tookMs: result.tookMs,
    };
}

module.exports = { declaration, impl };

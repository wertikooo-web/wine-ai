'use strict';

// Deterministic pairing core. It deliberately recommends a wine *style*, not
// a made-up producer or bottle. A catalog/official product profile can supply
// a concrete bottle later without changing the pairing logic.

const WINE_STYLES = Object.freeze([
    { id: 'viorica-dry', name: 'Viorica dry', grapes: ['viorica'], color: 'white', body: 1, acidity: 3, tannin: 0, sweetness: 1, sparkle: 0, notes: ['floral', 'citrus'], foods: ['fish', 'fresh_cheese', 'vegetable', 'poultry'] },
    { id: 'feteasca-alba', name: 'Fetească Albă', grapes: ['feteasca alba', 'fetească albă'], color: 'white', body: 2, acidity: 3, tannin: 0, sweetness: 1, sparkle: 0, notes: ['apple', 'floral'], foods: ['fish', 'fresh_cheese', 'vegetable', 'poultry'] },
    { id: 'feteasca-regala', name: 'Fetească Regală', grapes: ['feteasca regala', 'fetească regală'], color: 'white', body: 2, acidity: 3, tannin: 0, sweetness: 1, sparkle: 0, notes: ['apple', 'herbal'], foods: ['fish', 'poultry', 'vegetable', 'pork'] },
    { id: 'moldovan-rose-dry', name: 'Moldovan dry rosé', grapes: ['rara neagra', 'rara neagră', 'feteasca neagra', 'fetească neagră'], color: 'rose', body: 2, acidity: 3, tannin: 1, sweetness: 1, sparkle: 0, notes: ['red_berry', 'herbal'], foods: ['charcuterie', 'poultry', 'grilled_vegetable', 'spicy'] },
    { id: 'rara-neagra', name: 'Rară Neagră', grapes: ['rara neagra', 'rara neagră'], color: 'red', body: 2, acidity: 3, tannin: 2, sweetness: 1, sparkle: 0, notes: ['red_berry', 'spice'], foods: ['pork', 'lamb', 'mushroom', 'charcuterie'] },
    { id: 'feteasca-neagra', name: 'Fetească Neagră', grapes: ['feteasca neagra', 'fetească neagră'], color: 'red', body: 3, acidity: 2, tannin: 3, sweetness: 1, sparkle: 0, notes: ['black_berry', 'spice'], foods: ['lamb', 'beef', 'mushroom', 'aged_cheese'] },
    { id: 'moldovan-brut', name: 'Moldovan brut sparkling wine', grapes: ['chardonnay', 'pinot noir', 'feteasca alba', 'fetească albă'], color: 'sparkling', body: 1, acidity: 4, tannin: 0, sweetness: 1, sparkle: 1, notes: ['citrus', 'bread'], foods: ['aperitif', 'fried', 'fresh_cheese', 'fish'] },
]);

// First concrete profiles grounded in knowledge/source/manual-aurelius-winery.md.
// Only facts from that confirmed source are stored; pairing fields are clear
// style inferences and never claim a price, current stock, or award.
const OFFICIAL_BOTTLE_PROFILES = Object.freeze([
    { id: 'aurelius-cabernet-sauvignon-2018', name: 'Aurelius Cabernet Sauvignon 2018', aliases: ['aurelius cabernet sauvignon'], grapes: ['cabernet sauvignon'], color: 'red', body: 4, acidity: 2, tannin: 4, sweetness: 1, sparkle: 0, notes: ['black_berry', 'vanilla'], foods: ['beef', 'lamb', 'aged_cheese'], official_profile: { vintage: '2018', oak_months: 12, alcohol_percent: 14 }, profile_source: 'manual-aurelius-winery' },
    { id: 'aurelius-merlot-2019', name: 'Aurelius Merlot 2019', aliases: ['aurelius merlot'], grapes: ['merlot'], color: 'red', body: 3, acidity: 2, tannin: 2, sweetness: 1, sparkle: 0, notes: ['black_berry', 'floral'], foods: ['pork', 'mushroom', 'poultry'], official_profile: { vintage: '2019', oak_months: 12, alcohol_percent: 14 }, profile_source: 'manual-aurelius-winery' },
    { id: 'aurelius-feteasca-neagra-2018', name: 'Aurelius Fetească Neagră 2018', aliases: ['aurelius feteasca neagra', 'aurelius fetească neagră'], grapes: ['feteasca neagra', 'fetească neagră'], color: 'red', body: 3, acidity: 2, tannin: 3, sweetness: 1, sparkle: 0, notes: ['black_berry', 'spice'], foods: ['lamb', 'beef', 'mushroom', 'aged_cheese'], official_profile: { vintage: '2018', oak_months: 12, alcohol_percent: 14 }, profile_source: 'manual-aurelius-winery' },
    { id: 'aurelius-viorica-2021', name: 'Aurelius Viorica 2021', aliases: ['aurelius viorica'], grapes: ['viorica'], color: 'white', body: 1, acidity: 3, tannin: 0, sweetness: 1, sparkle: 0, notes: ['floral', 'citrus'], foods: ['fish', 'fresh_cheese', 'vegetable', 'poultry'], official_profile: { vintage: '2021', alcohol_percent: 13 }, profile_source: 'manual-aurelius-winery' },
    { id: 'aurelius-sauvignon-blanc-2022', name: 'Aurelius Sauvignon Blanc 2022', aliases: ['aurelius sauvignon blanc'], grapes: ['sauvignon blanc'], color: 'white', body: 2, acidity: 4, tannin: 0, sweetness: 1, sparkle: 0, notes: ['citrus', 'tropical'], foods: ['fish', 'fresh_cheese', 'vegetable', 'poultry'], official_profile: { vintage: '2022', alcohol_percent: 13 }, profile_source: 'manual-aurelius-winery' },
    { id: 'aurelius-rose-pinot-noir-2023', name: 'Aurelius Rosé Pinot Noir 2023', aliases: ['aurelius rose pinot noir', 'aurelius rosé pinot noir'], grapes: ['pinot noir'], color: 'rose', body: 2, acidity: 3, tannin: 1, sweetness: 1, sparkle: 0, notes: ['red_berry'], foods: ['charcuterie', 'poultry', 'grilled_vegetable', 'spicy'], official_profile: { vintage: '2023', alcohol_percent: 12 }, profile_source: 'manual-aurelius-winery' },
]);

const DISH_SIGNALS = Object.freeze([
    { keys: ['mamaliga', 'mămăligă', 'мамалыг'], food: 'fresh_cheese', body: 2, fat: 2, acidity: 1, spice: 0, salt: 2 },
    { keys: ['branza', 'brânză', 'brynza', 'брынз'], food: 'fresh_cheese', body: 1, fat: 2, acidity: 1, spice: 0, salt: 3 },
    { keys: ['placinta', 'plăcintă', 'плацинд'], food: 'fried', body: 2, fat: 3, acidity: 1, spice: 0, salt: 2 },
    { keys: ['sarmale', 'голубц'], food: 'pork', body: 3, fat: 3, acidity: 2, spice: 1, salt: 2 },
    { keys: ['mititei', 'mici', 'митите'], food: 'pork', body: 3, fat: 3, acidity: 1, spice: 2, salt: 2 },
    { keys: ['steak', 'beef', 'vită', 'говядин', 'стейк'], food: 'beef', body: 4, fat: 3, acidity: 1, spice: 1, salt: 2 },
    { keys: ['lamb', 'miel', 'ягнят', 'баранин'], food: 'lamb', body: 4, fat: 3, acidity: 1, spice: 1, salt: 2 },
    { keys: ['pork', 'porc', 'свинин'], food: 'pork', body: 3, fat: 3, acidity: 1, spice: 1, salt: 2 },
    { keys: ['fish', 'pește', 'peste', 'рыб', 'trout', 'păstrăv', 'форел'], food: 'fish', body: 2, fat: 1, acidity: 2, spice: 0, salt: 1 },
    { keys: ['chicken', 'pui', 'куриц'], food: 'poultry', body: 2, fat: 1, acidity: 1, spice: 0, salt: 1 },
    { keys: ['duck', 'duckling', 'rață', 'утк'], food: 'poultry', body: 3, fat: 3, acidity: 1, spice: 0, salt: 2 },
    { keys: ['mushroom', 'ciuperc', 'гриб'], food: 'mushroom', body: 3, fat: 2, acidity: 1, spice: 0, salt: 2 },
    { keys: ['salad', 'salată', 'салат', 'vegetable', 'legume', 'овощ'], food: 'vegetable', body: 1, fat: 1, acidity: 2, spice: 0, salt: 1 },
]);

function normalize(value) { return String(value || '').toLocaleLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim(); }
function includesAny(text, values) { return values.some((value) => text.includes(value)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function profileDish(dish, details = '') {
    const text = normalize(`${dish} ${details}`);
    const matched = DISH_SIGNALS.find((signal) => includesAny(text, signal.keys));
    const profile = matched ? { ...matched } : { food: 'unknown', body: 2, fat: 1, acidity: 1, spice: 0, salt: 1 };
    if (/(cream|creamy|smântân|сливоч)/u.test(text)) { profile.fat = clamp(profile.fat + 2, 0, 4); profile.body = clamp(profile.body + 1, 1, 4); }
    if (/(lemon|lămâi|лимон|tomato|roși|томат)/u.test(text)) profile.acidity = clamp(profile.acidity + 2, 0, 4);
    if (/(spicy|chili|iute|остр)/u.test(text)) profile.spice = clamp(profile.spice + 3, 0, 4);
    if (/(fried|prăjit|жарен)/u.test(text)) profile.fat = clamp(profile.fat + 2, 0, 4);
    return { ...profile, known: Boolean(matched), text };
}

function scoreStyle(style, dish) {
    let score = 60;
    score -= Math.abs(style.body - dish.body) * 10;
    if (style.foods.includes(dish.food)) score += 24;
    if (dish.fat >= 3) score += style.acidity * 5;
    if (dish.spice >= 3) score += style.sweetness * 7 - style.tannin * 5;
    if (dish.acidity >= 3) score += style.acidity * 4;
    if (dish.food === 'fish' && style.color === 'red') score -= 24;
    if ((dish.food === 'beef' || dish.food === 'lamb') && style.body < 3) score -= 16;
    return score;
}

function reasonFor(style, dish) {
    const reasons = [];
    if (dish.fat >= 3 && style.acidity >= 3) reasons.push('acidity refreshes the richer texture');
    if (dish.spice >= 3 && style.tannin <= 1) reasons.push('the lighter tannin keeps heat from becoming harsher');
    if (style.foods.includes(dish.food)) reasons.push('its body matches the main ingredient');
    if (!reasons.length) reasons.push('the wine and dish have a similar intensity');
    return reasons.slice(0, 2);
}

function recommendForDish({ dish, details, limit = 3 } = {}) {
    const profile = profileDish(dish, details);
    const clarificationNeeded = !profile.known && !details;
    const candidates = WINE_STYLES.map((style) => ({
        style_id: style.id,
        style_name: style.name,
        score: scoreStyle(style, profile),
        reasons: reasonFor(style, profile),
    })).sort((a, b) => b.score - a.score).slice(0, clamp(Number(limit) || 3, 1, 4));
    return {
        dish_profile: { food: profile.food, body: profile.body, fat: profile.fat, acidity: profile.acidity, spice: profile.spice },
        clarification: clarificationNeeded ? 'Ask how the dish is cooked and whether it has a creamy, tomato, lemon, or spicy sauce.' : null,
        candidates,
        inference: true,
    };
}

function findWineStyle({ wine, grapes = [], color, sweetness, description = '', catalogProfiles = [] } = {}) {
    const text = normalize([wine, ...(Array.isArray(grapes) ? grapes : [grapes]), color, sweetness, description].filter(Boolean).join(' '));
    const bottle = [...catalogProfiles, ...OFFICIAL_BOTTLE_PROFILES].find((profile) => (profile.aliases || [profile.name]).some((alias) => text.includes(normalize(alias))));
    if (bottle) return bottle;
    const matches = WINE_STYLES.map((style) => ({
        style,
        score: style.grapes.reduce((score, grape) => score + (text.includes(grape) ? 20 : 0), 0)
            + (text.includes(normalize(style.name)) ? 30 : 0)
            + (text.includes(style.color) ? 5 : 0),
    }))
        .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
    return matches[0]?.style || null;
}

function recommendForWine(input = {}) {
    const style = findWineStyle(input);
    if (!style) return { found: false, clarification: 'Ask for the wine name, grape variety, colour, sweetness, or the bottle label.', inference: false };
    const bestDishByType = new Map();
    for (const dish of DISH_SIGNALS) {
        const candidate = { dish: dish.food, score: scoreStyle(style, dish), reasons: reasonFor(style, dish) };
        const previous = bestDishByType.get(candidate.dish);
        if (!previous || candidate.score > previous.score) bestDishByType.set(candidate.dish, candidate);
    }
    const dishes = [...bestDishByType.values()]
        .sort((a, b) => b.score - a.score).slice(0, 4);
    return {
        found: true,
        wine_style: { id: style.id, name: style.name, color: style.color, body: style.body, acidity: style.acidity, tannin: style.tannin },
        ...(style.official_profile ? { bottle_profile: { ...style.official_profile, source: style.profile_source } } : {}),
        serving: { temperature_celsius: style.color === 'red' ? '15–18' : style.sparkle ? '6–8' : '8–12', decanting: style.color === 'red' && style.tannin >= 3 ? 'optional short aeration' : 'not needed' },
        dishes,
        inference: true,
    };
}

module.exports = { WINE_STYLES, OFFICIAL_BOTTLE_PROFILES, DISH_SIGNALS, profileDish, recommendForDish, findWineStyle, recommendForWine };

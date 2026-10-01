'use strict';

// Fix C: recommendation constraints parsed deterministically in RU / RO / EN
// (audit 1 Oct: RO 2/13, EN 7/13 -- the recommendation scenario never ran
// for Romanian or English at all). No LLM, folded text, vocabulary tables.

const t = require('./helpers/assertions');
const { parseRecommendationPreferences: P, detectScenario: D } = require('../src/knowledge/wineIntelligence');

async function run() {
    const matrix = [
        ['scenario', 'Посоветуй вино', 'Recomandă-mi un vin', 'Recommend me a wine', (q) => D(q) === 'recommend_wine'],
        ['red', 'Посоветуй красное вино', 'Recomandă-mi un vin roșu', 'Recommend a red wine', (q) => P(q).color === 'red'],
        ['white', 'Посоветуй белое вино', 'Recomandă-mi un vin alb', 'Recommend a white wine', (q) => P(q).color === 'white'],
        ['rosé', 'Посоветуй розовое вино', 'Recomandă-mi un vin roze', 'Recommend a rosé wine', (q) => P(q).color === 'rose'],
        ['sparkling', 'Посоветуй игристое вино', 'Recomandă-mi un vin spumant', 'Recommend a sparkling wine', (q) => P(q).color === 'sparkling'],
        ['dry', 'Посоветуй сухое вино', 'Recomandă-mi un vin sec', 'Recommend a dry wine', (q) => P(q).sweetness === 'dry'],
        ['semi-dry', 'Посоветуй полусухое вино', 'Recomandă-mi un vin demisec', 'Recommend a semi-dry wine', (q) => P(q).sweetness === 'semi_dry'],
        ['semi-sweet', 'Посоветуй полусладкое вино', 'Recomandă-mi un vin demidulce', 'Recommend a semi-sweet wine', (q) => P(q).sweetness === 'semi_sweet'],
        ['sweet', 'Посоветуй сладкое вино', 'Recomandă-mi un vin dulce', 'Recommend a sweet wine', (q) => P(q).sweetness === 'sweet'],
        ['budget', 'Посоветуй вино до 200 леев', 'Recomandă-mi un vin până la 200 lei', 'Recommend a wine under 200 lei', (q) => P(q).budget === 200],
        ['food', 'Посоветуй вино к рыбе', 'Recomandă-mi un vin la pește', 'Recommend a wine for fish', (q) => P(q).food === 'fish'],
        ['light body', 'Посоветуй лёгкое вино', 'Recomandă-mi un vin ușor', 'Recommend a light wine', (q) => P(q).body === 'light'],
        ['red dry ≤300', 'Посоветуй красное сухое до 300 леев', 'Vreau un vin roșu sec până la 300 de lei', 'I want a dry red wine under 300 lei', (q) => { const p = P(q); return p.color === 'red' && p.sweetness === 'dry' && p.budget === 300; }],
    ];
    for (const [name, ru, ro, en, ok] of matrix) {
        t.ok(ok(ru), `RU ${name}`); t.ok(ok(ro), `RO ${name}`); t.ok(ok(en), `EN ${name}`);
    }
    // Diacritics optional in RO; semi-* never collapses into dry/sweet.
    t.equal(P('Vreau un vin rosu sec').color, 'red');
    t.equal(P('Recommend a semi-dry white').sweetness, 'semi_dry');
    t.equal(P('Recommend a semi-sweet red').sweetness, 'semi_sweet');
    t.equal(D('What wine goes with fish?'), 'pair_food');
    // RU fixes: "к белому мясу" is not a colour; "лёгкое" parses.
    t.equal(P('Посоветуй вино к белому мясу').color, undefined);
    t.equal(P('Хочу лёгкое белое').body, 'light');
    // Budget only with an unambiguous cap or a currency.
    t.equal(P('Recommend a wine for 10 people').budget, undefined);
    t.equal(P('Recommend a wine for 250 lei').budget, 250);
    t.equal(P('A wine under 13% alcohol').budget, undefined);
    // Factual turns never start a recommendation, in any language.
    for (const q of ['What is Fetească Neagră?', 'Ce este Fetească Neagră?', 'Tell me about Purcari winery', 'Is red wine healthy?', 'How much does Negru de Purcari cost?', 'Cât costă vinul Negru de Purcari?', 'Unde se află crama Cricova?', 'How is sparkling wine made?', 'Расскажи про Fetească Neagră', 'Сколько стоит вино Cricova 1952?']) {
        t.equal(D(q), null, `factual: ${q}`);
    }
}

module.exports = { run };

if (require.main === module) {
    run().then(() => { console.log('recommendationLanguages tests passed'); process.exit(0); })
        .catch((error) => { console.error(error); process.exit(1); });
}

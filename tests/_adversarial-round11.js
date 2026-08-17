'use strict';

const assert = require('assert');
const {
    SCENARIOS,
    detectScenario,
    parseRecommendationPreferences,
} = require('../src/knowledge/wineIntelligence');

let pass = 0;
let fail = 0;
const failures = [];

function probe(label, fn) {
    try {
        fn();
        pass++;
        console.log(`  PASS: ${label}`);
    } catch (e) {
        fail++;
        const msg = `${label} — ${e.message}`;
        failures.push(msg);
        console.log(`  FAIL: ${msg}`);
    }
}

function scenarioIs(q, expected, label) {
    probe(label, () => assert.strictEqual(detectScenario(q), expected));
}
function budgetIs(q, expected, label) {
    probe(label, () => assert.strictEqual(parseRecommendationPreferences(q).budget, expected));
}

console.log('=== Round-10 confluence: MUST verify ===');

budgetIs('Хочу красное вино с выдержкой 5 лет до 300 леев', 300,
    'budget=300: aging+price');
budgetIs('Хочу красное вино танинностью 5 лет до 300 леев', 300,
    'budget=300: tannin+price');
budgetIs('Рекомендуй красное вино с выдержкой 3 года до 200 леев', 200,
    'budget=200: aging+price');
budgetIs('Хочу красное вино сахаром 30 до 300 леев', 300,
    'budget=300: sugar+price');
budgetIs('Хочу красное вино розливом 2024 до 300 леев', 300,
    'budget=300: bottling+price');

console.log('\n=== Still no leak ===');

budgetIs('Хочу красное вино танинностью до 30', undefined,
    'no leak: tannin-only');
budgetIs('Хочу красное вино выдержкой 5 лет', undefined,
    'no leak: aging-only');
budgetIs('Хочу красное вино крепостью до 13', undefined,
    'no leak: strength-only');
budgetIs('Хочу красное вино розливом 2024', undefined,
    'no leak: bottling-only');

console.log('\n=== Detection unchanged ===');

scenarioIs('Хочу красное вино крепостью до 13', SCENARIOS.RECOMMEND_WINE,
    'det: strength pref');
scenarioIs('Хочу красное вино танинностью до 30', SCENARIOS.RECOMMEND_WINE,
    'det: tannin pref');
scenarioIs('Хочу красное вино с выдержкой 5 лет до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'det: aging+price');
scenarioIs('Подскажи цену на красное вино Cricova 1952 до 300 леев', null,
    'det: named+price ask');
scenarioIs('Сколько стоит вино Cricova 1952', null,
    'det: factual price');
scenarioIs('Хочу красное яблоко', SCENARIOS.RECOMMEND_WINE,
    'det: descriptor+verb');

console.log('\n=== NEW A: PRICE_AMOUNT_RE currency formats ===');

// A1: spelled-out budget (no digits) — budget undefined is acceptable
budgetIs('Хочу красное вино до трёхсот леев', undefined,
    'A1: spelled-out number — no digits, budget undefined');
scenarioIs('Хочу красное вино до трёхсот леев', SCENARIOS.RECOMMEND_WINE,
    'A1: scenario still recommend');

// A2: по 500 lei
budgetIs('Хочу красное вино по 500 lei', 500, 'A2: по 500 lei');

// A3: до 300 мдл
budgetIs('Хочу красное вино до 300 мдл', 300, 'A3: до 300 мдл');

// A4: до 300 молдавских леев
budgetIs('Хочу красное вино до 300 молдавских леев', 300,
    'A4: до 300 молдавских леев');

// A5: uppercase ДО 300 ЛЕЕВ
budgetIs('Хочу красное вино ДО 300 ЛЕЕВ', 300,
    'A5: uppercase ДО 300 ЛЕЕВ');

// A6: не дороже 1000 леев
budgetIs('Хочу красное вино не дороже 1000 леев', 1000,
    'A6: не дороже 1000 леев');

// A7: в пределах 500 леев
budgetIs('Хочу красное вино в пределах 500 леев', 500,
    'A7: в пределах 500 леев');

// A8: в районе 400 леев
budgetIs('Хочу красное вино в районе 400 леев', 400,
    'A8: в районе 400 леев');

// A9: под 350 леев
budgetIs('Хочу красное вино под 350 леев', 350,
    'A9: под 350 леев');

console.log('\n=== NEW B: Qualifier+budget variants ===');

// B1
budgetIs('Хочу красное вино с выдержкой 5 лет до 300 леев', 300,
    'B1: aging+price → 300');
scenarioIs('Хочу красное вино с выдержкой 5 лет до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'B1: scenario recommend');

// B2
budgetIs('Хочу красное вино кислотностью 3 до 500 леев', 500,
    'B2: acidity+price → 500');
scenarioIs('Хочу красное вино кислотностью 3 до 500 леев', SCENARIOS.RECOMMEND_WINE,
    'B2: scenario recommend');

// B3
budgetIs('Хочу красное вино танинами 30 до 300 леев', 300,
    'B3: tannins+price → 300');
scenarioIs('Хочу красное вино танинами 30 до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'B3: scenario recommend');

// B4: г/л unit may block dash — verify
budgetIs('Хочу красное вино сахаром 30 г/л до 400 леев', 400,
    'B4: sugar г/л+price → 400');
scenarioIs('Хочу красное вино сахаром 30 г/л до 400 леев', SCENARIOS.RECOMMEND_WINE,
    'B4: scenario recommend');

// B5: price first, qualifier after
budgetIs('Хочу красное вино до 300 леев с выдержкой 5 лет', 300,
    'B5: price-first → 300');
scenarioIs('Хочу красное вино до 300 леев с выдержкой 5 лет', SCENARIOS.RECOMMEND_WINE,
    'B5: scenario recommend');

// B6: крепость + price
budgetIs('Хочу красное вино крепостью 13 до 300 леев', 300,
    'B6: strength+price → 300');
scenarioIs('Хочу красное вино крепостью 13 до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'B6: scenario recommend');

// B7: до 300 л — litres, NOT lei — must NOT become budget
budgetIs('Хочу красное вино до 300 л', undefined,
    'B7: л=litres not lei → undefined');
scenarioIs('Хочу красное вино до 300 л', SCENARIOS.RECOMMEND_WINE,
    'B7: scenario recommend');

// B8: до 300 (no unit) — report the value
budgetIs('Хочу красное вино до 300', 300,
    'B8: bare number → 300 (acceptable)');
scenarioIs('Хочу красное вино до 300', SCENARIOS.RECOMMEND_WINE,
    'B8: scenario recommend');

console.log('\n=== C: Full prior-round regression sweep ===');

// Nulls
scenarioIs('Сколько стоит вино Cricova 1952', null,
    'C-null: factual price');
scenarioIs('Подскажи цену на красное вино Cricova 1952 до 300 леев', null,
    'C-null: named+price ask');
scenarioIs('Хочу узнать крепость красного вина до 13 градусов', null,
    'C-null: generic strength');
scenarioIs('Подскажи, какая крепость у вина Cricova до 13 градусов?', null,
    'C-null: named strength');
scenarioIs('Чем отличается красное вино от белого?', null,
    'C-null: education compare colour');
scenarioIs('Сравни молдавское вино и французское', null,
    'C-null: generic category compare');
scenarioIs('Расскажи о виноделии', null,
    'C-null: education');
scenarioIs('Подскажи сахар красного вина', null,
    'C-null: sugar ask');
scenarioIs('Подскажи сладость красного вина', null,
    'C-null: sweetness ask');
scenarioIs('Какой сахар у Cricova?', null,
    'C-null: named sugar ask');

// recommend_wine
scenarioIs('Хочу красное яблоко', SCENARIOS.RECOMMEND_WINE,
    'C-rec: descriptor+verb');
scenarioIs('Хочу сухое белое до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'C-rec: budget+colour');
scenarioIs('Подскажи цену на красное вино до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'C-rec: budget rescues price');
scenarioIs('Хочу узнать цену красного вина по 300 леев', SCENARIOS.RECOMMEND_WINE,
    'C-rec: по budget rescues');
scenarioIs('Посоветуй красное вино Cricova до 300 леев', SCENARIOS.RECOMMEND_WINE,
    'C-rec: named+no factual attr → recommend');
scenarioIs('Рекомендуй винтажное красное вино', SCENARIOS.RECOMMEND_WINE,
    'C-rec: винтажное adj');
scenarioIs('Рекомендуй красное вино крепостью 13', SCENARIOS.RECOMMEND_WINE,
    'C-rec: strength pref');
scenarioIs('Рекомендуй сладостное красное вино', SCENARIOS.RECOMMEND_WINE,
    'C-rec: сладостное adj');
scenarioIs('Рекомендуй танинное красное вино', SCENARIOS.RECOMMEND_WINE,
    'C-rec: танинное adj');
scenarioIs('Хочу сладко-кислое красное вино', SCENARIOS.RECOMMEND_WINE,
    'C-rec: sweet-sour adj');

// compare_wines
scenarioIs('В чем отличие Cricova от Purcari?', SCENARIOS.COMPARE_WINES,
    'C-cmp: two wineries');
scenarioIs('Сравни Cricova', SCENARIOS.COMPARE_WINES,
    'C-cmp: one winery → compare handler');

console.log('\n=== BONUS: additional regression probes ===');

// BUDGET_QUALIFIER_RE not firing on adjective forms
scenarioIs('Рекомендуй сладкое красное вино', SCENARIOS.RECOMMEND_WINE,
    'regression: сладкое adj stays recommend');
scenarioIs('Рекомендуй кислое красное вино', SCENARIOS.RECOMMEND_WINE,
    'regression: кислое adj stays recommend');

// "под" as preposition vs budget
scenarioIs('Хочу красное вино под 350 леев', SCENARIOS.RECOMMEND_WINE,
    'regression: под 350 леев is budget');
budgetIs('Хочу красное вино под 350 леев', 350,
    'regression: под 350 леев extracts 350');

// PRICE_AMOUNT_RE edge: "до 300леев" (no space before currency)
budgetIs('Хочу красное вино до 300леев', 300,
    'A-edge: no space before lei → 300');

// Named wine with qualifier but no question marker
scenarioIs('Хочу красное вино крепостью 13', SCENARIOS.RECOMMEND_WINE,
    'regression: no question marker → recommend');

console.log('\n=== SUMMARY ===');
console.log(`Passed: ${pass}`);
console.log(`Failed: ${fail}`);
if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
process.exit(fail > 0 ? 1 : 0);

'use strict';

const t = require('./helpers/assertions');
const { profileDish, recommendForDish, recommendForWine } = require('../src/pairing/pairingEngine');

async function run() {
    const fish = profileDish('форель с лимонным соусом');
    t.equal(fish.food, 'fish');
    t.ok(fish.acidity >= 3, 'lemon sauce must raise dish acidity');

    const fishPairing = recommendForDish({ dish: 'форель с лимонным соусом' });
    t.ok(['viorica-dry', 'feteasca-alba', 'feteasca-regala', 'moldovan-brut'].includes(fishPairing.candidates[0].style_id), 'fresh fish should prefer a fresh white or sparkling style');
    t.ok(!fishPairing.candidates.some((entry) => entry.style_id === 'feteasca-neagra'), 'structured red must not be recommended for fresh fish');

    const lambPairing = recommendForDish({ dish: 'lamb with herbs' });
    t.equal(lambPairing.candidates[0].style_id, 'feteasca-neagra', 'lamb should prefer structured red');

    const fromWine = recommendForWine({ wine: 'Rară Neagră' });
    t.ok(fromWine.found, 'grape name must resolve a wine style');
    t.equal(fromWine.wine_style.id, 'rara-neagra');
    t.ok(fromWine.dishes.some((entry) => entry.dish === 'lamb'), 'reverse recommendation must include compatible food');

    const unknown = recommendForWine({ wine: 'Unknown bottle' });
    t.equal(unknown.found, false, 'unknown bottle must request more label details rather than inventing a style');

    const aurelius = recommendForWine({ wine: 'Aurelius Sauvignon Blanc 2022' });
    t.equal(aurelius.found, true, 'a confirmed project bottle profile must resolve');
    t.equal(aurelius.bottle_profile.vintage, '2022', 'the response must keep the confirmed bottle vintage');
    t.equal(aurelius.bottle_profile.source, 'manual-aurelius-winery', 'a concrete profile must retain its evidence source');
}

module.exports = { run };

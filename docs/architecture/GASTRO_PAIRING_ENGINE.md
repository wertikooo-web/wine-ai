# Gastro Pairing Engine

## Purpose

The pairing engine provides an explainable recommendation in both directions:

- dish → ranked Moldovan wine styles;
- selected wine → food matches and serving guidance.

It is a recommendation layer, so every result is marked internally as an
inference. It never creates a winery, bottle, vintage, price, or award.

## Input and decision model

For a dish, the engine detects the main ingredient, body, fat, acidity, and
spice. Preparation and sauce adjust that profile. A missing detail only
produces a clarification when it can materially change the pairing.

For a wine, the engine resolves a style from the supplied name, grape variety,
colour, sweetness, and confirmed product description. An unresolved bottle
returns a request for label details rather than a guess.

## Data ownership

`src/pairing/pairingEngine.js` owns stable style profiles, pairing rules, and
the first concrete bottle profiles already confirmed in the project corpus:
Aurelius Cabernet Sauvignon 2018, Merlot 2019, Fetească Neagră 2018, Viorica
2021, Sauvignon Blanc 2022, and Rosé Pinot Noir 2023. Each retains
`manual-aurelius-winery` as its evidence source. WineMD catalog data remains
the source for volatile commerce fields; price and stock never enter this
engine.

## Runtime contract

`recommend_wine_pairing` returns a dish profile, up to three ranked style
candidates, concise reasons, and an optional clarification.

`recommend_wine_serving` returns a resolved style, serving guidance, and up to
four distinct food categories. Both tools require the host to supply an
age-verified adult session; otherwise they return `age_verification_required`.

## Quality gates

Tests cover sauce-sensitive food profiling, rejection of structured red for
fresh fish, dish-to-wine ranking, wine-to-food ranking, unknown-bottle
behaviour, tool payload shape, and the adult-session gate.

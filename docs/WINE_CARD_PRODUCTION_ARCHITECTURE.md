# Wine Card Production Architecture

Status: proposed architecture, implementation foundation started locally.

This document defines the smallest production architecture that replaces the
hardcoded demo catalog with verified KOS records. The first validation target
is one real Aurelius wine.

## Current-state audit

### KOS

The KOS foundation is substantial but is not production-ready.

- Existing entities: wineries, wines, vintages, grapes, sources, evidences,
  facts, crawl runs, parsed documents and candidate drafts.
- Existing lifecycle: extraction -> validation -> fact publication.
- Production `/health` reports `kos.ready = false`.
- Blocking error: migration v1 checksum drift between the database and code.
- The local website-source integration has a failing unit test.

Migration v1 must not be edited or force-marked as applied. Resolution requires
comparing the stored production migration with its historical source and then
adding a forward-only migration if the schema needs to change.

### S3-compatible storage

An S3-compatible adapter exists locally and its isolated test passes, but it is
not yet an operating production capability.

- Its code, AWS dependencies and environment examples are uncommitted.
- Railway has no `KOS_STORAGE_PROVIDER` or `S3_*` configuration.
- Production reports `storageProvider = local` and
  `storageProductionReady = false`.
- Bucket delivery, CORS, rights, retention and backup are not validated.

## Architectural principles

1. No card is created from unrestricted model prose.
2. Only a published wine with a stable `wineId` can be shown.
3. Facts, media and commerce are separate domains.
4. Every published factual field retains provenance.
5. The crawler creates candidates and never publishes automatically.
6. Voice continues if card, media or commerce resolution fails.
7. The demo catalog remains only as a development fixture.

## Data ownership

Existing KOS tables remain canonical:

- `kos_wineries`
- `kos_wines`
- `kos_wine_vintages`
- `kos_vintage_grape_varieties`
- `kos_knowledge_sources`
- `kos_fact_evidences`
- `kos_knowledge_facts`

After KOS drift is repaired, add forward-only tables:

### `kos_wine_card_versions`

- wine and vintage ids
- locale and version
- `draft | pending_review | published | archived`
- localized description
- aroma and pairing ids
- publication audit fields

Only one published version per wine, vintage and locale.

### `kos_wine_media_assets`

- wine/vintage ids
- `bottle | front_label | back_label | hero | broll`
- storage key, checksum, dimensions and MIME type
- `rights_status`
- `draft | approved | archived`
- source and validity dates

Runtime may use only rights-approved and approved media.

### `kos_commerce_offers`

- wine/vintage and merchant ids
- SKU, price, currency and availability
- order URL and freshness
- `draft | active | inactive`

Price is never stored as an objective wine fact.

## Published Wine Card contract

The frontend receives one server-owned DTO and never joins data itself.

```json
{
  "schemaVersion": 1,
  "wineId": "wine_aurelius_example",
  "vintageId": "vintage_aurelius_example_2022",
  "publicationStatus": "published",
  "locale": "ru",
  "identity": {
    "name": "Official wine name",
    "wineryId": "winery_aurelius",
    "wineryName": "Aurelius",
    "vintage": 2022,
    "region": "Codru, Moldova"
  },
  "technical": {
    "wineType": "red",
    "sweetness": "dry",
    "grapes": [{ "name": "Fetească Neagră", "percentage": 100 }],
    "alcoholPercentage": 13.5,
    "servingTemperature": "16–18°"
  },
  "presentation": {
    "shortDescription": "Verified localized description",
    "aromas": ["blackberry", "plum", "oak"],
    "pairings": ["duck", "aged_cheese"]
  },
  "media": {
    "bottle": {
      "url": "signed-or-public-url",
      "alt": "Official bottle image",
      "rightsStatus": "approved"
    }
  },
  "commerce": null,
  "provenance": {
    "verified": true,
    "sourceIds": ["source_official_technical_sheet"],
    "updatedAt": "2026-07-23T00:00:00.000Z"
  }
}
```

If no active offer exists, commerce is `null` and no order action is rendered.

## Runtime API

- `GET /api/wines/:wineId/card?locale=ru`
- `GET /api/wineries/:wineryId/wines?status=published`

Rules:

- `404` for unknown wine;
- `409` for an existing but unpublished card;
- `200` only for a valid published DTO;
- media and commerce failures degrade to `null`;
- unpublished facts never appear.

## Visual Intent Gate

The microphone controls the avatar lifecycle only. It does not authorize a
wine card.

Trusted inputs:

- authoritative tool result with a published `wineId`;
- recommendation-engine selection;
- explicit wine screen context;
- active published wine context for a follow-up.

Decisions:

- `avatar_only`
- `show_wine`
- `show_wine_with_commerce`
- `keep_current_wine`
- `clear_visual`

The gate rejects assistant prose, unpublished wines, low-confidence entity
matches and unverified commerce.

## Aurelius vertical validation

1. Select one official Aurelius wine.
2. Register winery, wine and vintage identities.
3. Attach official sources.
4. Validate and publish objective facts.
5. Upload one rights-approved bottle image.
6. Create one localized card version.
7. Optionally attach one active offer.
8. Resolve the DTO through the API.
9. Test direct questions, recommendations, follow-ups and unrelated questions.

Acceptance criteria:

- unrelated questions never open a wine card;
- direct questions open only the resolved wine;
- recommendations open the selected wine;
- follow-ups keep the same wine;
- price/order require an active offer;
- unpublished cards are unavailable;
- voice survives all visual failures.

## Ownership boundaries

Safe now:

- DTO contract and validator;
- pure Visual Intent Gate;
- unit tests;
- API specification.

Wait for Antigravity or explicit takeover:

- repairing the KOS migration ledger;
- changing KOS migrations;
- completing website-source ingestion;
- committing the S3 adapter and AWS dependencies;
- configuring Railway storage.

After KOS recovery, add forward-only migrations and build the read-only Wine
Card resolver/API around one Aurelius record.

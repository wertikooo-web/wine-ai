# WINE AI Knowledge Strategy and Roadmap

Status: deferred strategic initiative. Preserve this document as the approved analysis and implementation roadmap. Do not start implementation from this document without a separate task.

Date: 2026-08-02

## 1. Purpose

WINE AI should answer as a confident wine expert while keeping every factual claim traceable to a reliable source. The product must combine stable project knowledge, live Wine.md commerce data, document retrieval, and carefully controlled internet fallback.

The visible answer should sound natural. Internal mechanics, tool names, empty database states, and fallback routing should remain hidden from the user. Sources, confidence, freshness, and AI inference should be available in the interface and administration tools.

The target product is a shared wine knowledge platform used by the kiosk, Wine.md widget, websites, mobile clients, future messaging channels, and partner APIs.

## 2. Approved knowledge hierarchy

### Level 1. Canonical Knowledge

Contains stable, validated entities, facts, aliases, and relationships.

Examples:

- wineries, wines, grape varieties, regions, people, routes, restaurants, hotels, tours;
- canonical names and aliases in Russian, Romanian, and English;
- founding year, region, location, producer, grape composition, style, facilities;
- source provenance, confidence, validation status, freshness, and history.

This layer is the authoritative source for stable facts. It must contain only approved or published knowledge for production answers.

### Level 2. Wine.md Catalog

Contains dynamic commerce data:

- price;
- availability and stock;
- bottle format;
- product image;
- product page;
- purchase link;
- last synchronization time.

Dynamic fields must remain separate from stable canonical facts. A wine entity should link to a Wine.md product, while the live catalog owns price and availability.

### Level 3. Document Knowledge

Contains evidence and context from:

- books;
- PDF files;
- ONVV materials;
- winery websites;
- industry publications;
- uploaded documents;
- approved crawled pages.

This is the RAG layer for history, terroir, production methods, tasting context, tourism details, quotations, and explanations that are unsuitable for compact structured facts.

### Level 4. Internet Fallback

Used only when:

- the first three levels cannot support a reliable answer;
- the question is freshness-sensitive;
- the user asks about current events, schedules, awards, opening hours, tickets, or newly published information;
- a disputed fact needs current verification.

Preferred web source order:

1. official winery website;
2. ONVV and government sources;
3. Wine.md and approved partners;
4. official event pages;
5. specialist media;
6. general web sources.

The assistant should not announce that web search was used. The interface may show the source and the date checked.

## 3. Answer behavior

The user should receive a direct, confident answer based on the strongest available evidence.

Forbidden response habits:

- exposing internal routing;
- saying that the internal database has no information;
- announcing that the internet was searched;
- presenting an AI recommendation as a verified fact;
- combining conflicting claims into one certain statement.

When a fact cannot be confirmed, the assistant should name the exact uncertainty in natural language. Example: the current excursion price cannot be reliably confirmed. It should not describe the internal failure path.

Fresh data should include a freshness signal in the UI, such as updated 15 minutes ago or checked today.

## 4. Answer modes

These modes are for administration, benchmarking, and partner API configuration. Ordinary kiosk users should normally receive one automatic production mode.

### knowledge_only

Uses canonical facts and approved documents. Internet and live catalog data are excluded. AI inference should be minimal.

Purpose: strict factual testing, hallucination detection, regulated or partner-controlled deployments.

### knowledge_catalog

Uses canonical facts, approved documents, and Wine.md catalog data.

Purpose: product cards, price, availability, purchase flows, and retail recommendations.

### knowledge_web

Uses canonical facts, Wine.md, documents, and controlled web fallback.

Purpose: default production mode for current information and broad user questions.

### expert

Uses all approved evidence and permits explicit AI inference for recommendations, routes, comparisons, and pairings.

AI-generated conclusions must be marked internally as inference and linked to the evidence used.

## 5. Claim-level provenance

Every meaningful statement in a generated answer should be classified and traceable.

Required claim categories:

- verified_fact;
- live_catalog_fact;
- document_supported_fact;
- current_web_fact;
- ai_inference;
- unresolved_or_conflicting.

Recommended internal claim structure:

```json
{
  "claim": "The winery is located in the Codru region.",
  "kind": "verified_fact",
  "entity_id": "winery_example",
  "source_type": "official_industry",
  "source_title": "Source title",
  "source_url": "https://example.com",
  "page": 84,
  "confidence": "verified",
  "verified_at": "2026-08-02T00:00:00Z"
}
```

For an AI recommendation:

```json
{
  "claim": "I would choose this wine for duck with cherry sauce.",
  "kind": "ai_inference",
  "based_on": ["wine_profile_123", "pairing_rule_47"],
  "confidence": "medium"
}
```

The voice response should stay natural. The screen and admin panel should expose provenance when useful.

## 6. Answer Audit

Build an administrative Answer Audit screen after the current task is resumed.

Required inputs:

- question;
- language;
- answer mode;
- answer length;
- optional user constraints.

Required outputs:

- final answer;
- used knowledge levels;
- claim-by-claim provenance;
- source links and page references;
- confidence and freshness;
- conflicts;
- AI inference markers;
- latency;
- model and tool usage;
- estimated cost where available;
- constraint compliance.

A claim without a source or an explicit inference marker should be treated as a quality defect.

## 7. Knowledge Graph scope

A full external graph database is not required at the current stage. PostgreSQL can support the first production-grade graph using normalized tables and recursive queries.

Recommended core tables:

- entities;
- entity_aliases;
- entity_facts;
- entity_relations;
- fact_sources;
- fact_history;
- relation_history;
- review_queue;
- catalog_products;
- catalog_sync_runs.

Core entity types:

- winery;
- producer;
- brand;
- wine;
- wine_line;
- vintage;
- grape_variety;
- wine_region;
- subregion;
- geographic_place;
- terroir;
- winemaker;
- founder;
- owner;
- sommelier;
- tour;
- tasting;
- restaurant;
- hotel;
- museum;
- wine_route.

Initial relation vocabulary:

- produces;
- made_from;
- blend_percentage;
- located_in;
- part_of_region;
- uses_grape;
- offers_tour;
- offers_tasting;
- has_restaurant;
- has_hotel;
- has_museum;
- founded_by;
- owned_by;
- has_aroma;
- has_flavor;
- food_pairing;
- won_award;
- available_as_product.

Unknown relation types should enter needs_review rather than production answers.

## 8. Knowledge Studio

Knowledge Studio should become the operational editor for the knowledge asset.

Required entity card:

- canonical name and type;
- RU, RO, and EN aliases;
- descriptions and sources;
- incoming and outgoing relations;
- facts, quotations, documents, and evidence;
- neighboring graph view;
- revision history.

Required editor actions:

- edit name, type, and description;
- add or remove aliases;
- add facts and sources;
- approve, publish, reject, or return to review;
- merge duplicate entities;
- create or edit a relation;
- roll back a change.

Required review queues:

- low confidence;
- missing source;
- possible duplicate;
- conflicting sources;
- expired or stale fact;
- unknown entity or relation type;
- content outside the product scope.

## 9. What already exists in wine-ai

The main project already contains substantial foundations:

- document RAG;
- PostgreSQL knowledge chunks and embeddings;
- hybrid retrieval;
- web search tools;
- Wine.md availability and purchase tools;
- structured entity facts with source hierarchy and TTL concepts;
- provenance metadata in parts of the retrieval pipeline;
- knowledge administration and KOS source workflows.

A layered routing implementation was previously created and tested, but repository history later diverged. Before resuming this initiative, verify the current main branch and production deployment. Do not assume that the earlier layered routing files are still present in the active main branch.

## 10. What exists in wineMD-widget and may be reused conceptually

The parallel wineMD-widget project contains useful working patterns:

- answer modes;
- claim-level provenance;
- Answer Audit UI;
- Knowledge Studio flows;
- graph inspection;
- source visibility;
- review statuses and queues;
- Wine.md catalog synchronization;
- benchmark questions and provenance tests.

Do not copy the entire implementation blindly. The two repositories have different schemas, runtime contracts, authentication, and deployment paths. Reuse data contracts, UX patterns, test cases, and ontology decisions where compatible.

## 11. Key risks

### Repository and production drift

Earlier work showed that production and main may diverge. Any resumed work must first verify:

- current main head;
- deployed build timestamp and commit;
- registered tools;
- active knowledge source;
- current database schema.

### Duplicate truth stores

JSON entity facts, PostgreSQL facts, document chunks, and catalog data can become competing sources. Each data type needs one owner.

### False confidence

A polished answer can hide weak evidence. Claim-level provenance and benchmark assertions are mandatory.

### Freshness mistakes

Prices, stock, opening hours, schedules, and events require TTL and fresh source checks.

### Overbuilding the graph

A large ontology without answer-quality tests can consume months. Build only relations needed by real user questions.

### Public exposure of internal data

Audit exports must not contain secrets, local paths, private documents, personal data, or raw credentials.

## 12. Recommended implementation sequence

### Phase 0. Reconciliation and safety

1. Verify active main, production build, and deployed tool registry.
2. Reconcile or restore layered routing without losing newer realtime and UI work.
3. Add integration tests proving the current production path.
4. Freeze public contracts for tool results and provenance.

Exit condition: repository, CI, and production describe the same routing behavior.

### Phase 1. Answer modes and provenance

1. Define answer mode configuration.
2. Define the claim provenance contract.
3. Route canonical, catalog, documents, and web evidence through one orchestrator.
4. Separate facts from AI inference.
5. Add conflict and freshness handling.

Exit condition: every benchmark answer can explain each claim.

### Phase 2. Answer Audit and benchmark

1. Build the administrative Answer Audit screen.
2. Create 50 to 100 reference questions in RU, RO, and EN.
3. Include entity questions, current data, constraints, unknowns, conflicts, routes, and pairings.
4. Add assertions for source quality, hallucination rate, freshness, constraints, and latency.

Exit condition: repeatable quality report exists for every release.

### Phase 3. Wine.md catalog hardening

1. Establish one structured catalog table and sync process.
2. Link catalog products to canonical wine entities.
3. Add freshness monitoring and sync failures to admin.
4. Test price, availability, photo, and purchase flows.

Exit condition: catalog answers use current structured data with timestamps.

### Phase 4. Entity relations v1

1. Normalize major wineries, wines, grapes, and regions.
2. Add a controlled relation vocabulary.
3. Build only relations required by benchmark questions.
4. Add duplicate detection and merge history.

Exit condition: multi-condition queries work without relying only on semantic text similarity.

### Phase 5. Knowledge Studio

1. Build entity cards and relation editing.
2. Add review queues and history.
3. Add conflict and stale-fact workflows.
4. Add source and graph inspection.

Exit condition: an editor can repair knowledge without direct PostgreSQL access.

### Phase 6. Wine Intelligence

After the knowledge base is reliable, add:

- personalized wine recommendations;
- route planning with time, budget, season, and distance constraints;
- style-based wine comparison;
- explainable food pairing;
- missing-link suggestions;
- conflict detection and editor recommendations.

Every inference must remain explainable from facts and evidence.

## 13. Priority when work resumes

Recommended near-term allocation:

- repository and production reconciliation: critical first step;
- Answer Audit and claim provenance: 30%;
- reference benchmark: 25%;
- Wine.md catalog freshness: 20%;
- entity relations v1: 15%;
- Knowledge Studio improvements: 10%.

The allocation should move toward graph and Studio only after answer quality can be measured reliably.

## 14. Definition of done for the initiative

The initiative is ready for production when:

- one orchestrator applies the four knowledge levels;
- ordinary users receive direct natural answers;
- every factual claim has provenance;
- every AI conclusion is marked as inference internally;
- current data includes freshness;
- conflicting sources are visible and not silently merged;
- the admin can compare answer modes;
- a multilingual benchmark runs in CI;
- catalog sync is observable;
- editors can correct core facts and relations without direct database work;
- production and main are verified to match.

## 15. Deferred decision

This initiative is intentionally paused after this document is stored. Resume only through a new explicit task that starts with Phase 0 reconciliation. Do not continue implementation merely because this roadmap exists.
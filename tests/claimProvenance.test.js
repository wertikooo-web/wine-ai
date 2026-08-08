'use strict';

const assert = require('assert');
const {
    CLAIM_KINDS,
    claimKindForItem,
    sourceForItem,
    freshnessForItem,
    buildClaimsFromEvidence,
    conflictKeyForItem,
    annotateConflicts,
    summarizeFreshness,
    rankClaims,
} = require('../src/knowledge/claimProvenance');

function canonicalItem() {
    return {
        level: 'canonical',
        text: 'founding_year: 1997',
        title: 'purcari',
        source: 'https://purcari.md',
        source_type: 'canonical',
        confidence: 'verified',
        provenance: {
            entity_id: 'purcari',
            verified_at: '2026-01-10T00:00:00.000Z',
            expires_at: null,
        },
    };
}

function catalogItem() {
    return {
        level: 'catalog',
        text: 'Purcari Alb de Purcari',
        title: 'Alb de Purcari',
        source: 'https://wine.md/',
        source_type: 'partner_catalog',
        confidence: 'verified',
        catalog: {
            external_id: 'wine-42',
            price: 249,
            currency: 'MDL',
            availability: 'in_stock',
            stock_quantity: 14,
            last_synced_at: '2026-08-01T00:00:00.000Z',
        },
    };
}

function documentItem() {
    return {
        level: 'documents',
        text: 'Feteasca Neagra is the signature Moldovan grape.',
        title: 'Grapes of Moldova',
        source: 'docs/moldova-grapes.md',
        source_type: 'document',
        confidence: 'high',
        relevance_score: 0.9,
        provenance: {
            source_file: 'docs/moldova-grapes.md',
            chunk_id: 'chunk-1',
            language: 'ro',
        },
    };
}

function webItem() {
    return {
        level: 'web',
        text: 'Cricova hosts an annual wine festival in September.',
        title: 'Visit Moldova',
        source: 'https://visit.md/events/cricova',
        source_type: 'official_event',
        confidence: 'medium',
        provenance: { url: 'https://visit.md/events/cricova', provider: 'brave' },
    };
}

async function run() {
    assert.strictEqual(claimKindForItem(canonicalItem()), CLAIM_KINDS.VERIFIED_FACT);
    assert.strictEqual(claimKindForItem(catalogItem()), CLAIM_KINDS.LIVE_CATALOG_FACT);
    assert.strictEqual(claimKindForItem(documentItem()), CLAIM_KINDS.DOCUMENT_SUPPORTED_FACT);
    assert.strictEqual(claimKindForItem(webItem()), CLAIM_KINDS.CURRENT_WEB_FACT);
    assert.strictEqual(claimKindForItem(null), null);
    assert.strictEqual(claimKindForItem({ level: 'unknown' }), null);

    // Canonical provenance: verified_at exposed, source URL carried.
    const cSource = sourceForItem(canonicalItem());
    assert.strictEqual(cSource.url, 'https://purcari.md');
    assert.strictEqual(cSource.verified_at, '2026-01-10T00:00:00.000Z');
    assert.strictEqual(cSource.expires_at, null);

    // Catalog provenance: checked_at = last sync, product URL preferred.
    const catSource = sourceForItem(catalogItem());
    assert.strictEqual(catSource.checked_at, '2026-08-01T00:00:00.000Z');

    // Document provenance: page = source_file.
    const docSource = sourceForItem(documentItem());
    assert.strictEqual(docSource.document_page, 'docs/moldova-grapes.md');
    assert.strictEqual(docSource.chunk_id, 'chunk-1');

    // Web provenance: provider exposed.
    assert.strictEqual(sourceForItem(webItem()).provider, 'brave');

    // Freshness: catalog with price/stock is dynamic and dated.
    const catFreshness = freshnessForItem(catalogItem());
    assert.strictEqual(catFreshness.dynamic, true);
    assert.ok(catFreshness.fields.includes('price'));
    assert.strictEqual(catFreshness.as_of, '2026-08-01T00:00:00.000Z');

    const docFreshness = freshnessForItem(documentItem());
    assert.strictEqual(docFreshness.dynamic, false);

    // Claims carry id/kind/source/freshness, never a leaked internal key.
    const claims = buildClaimsFromEvidence([canonicalItem(), catalogItem(), documentItem(), webItem()]);
    assert.strictEqual(claims.length, 4);
    assert.strictEqual(claims[0].id, 'claim_1');
    assert.strictEqual(claims[0].kind, CLAIM_KINDS.VERIFIED_FACT);
    assert.strictEqual(claims[0].entity_id, 'purcari');
    assert.strictEqual(claims[3].kind, CLAIM_KINDS.CURRENT_WEB_FACT);

    // Conflict keys computed identically to detectConflicts' key format.
    assert.strictEqual(conflictKeyForItem(canonicalItem()), 'purcari:founding_year');
    assert.strictEqual(conflictKeyForItem(catalogItem()), 'wine-42:price');

    // annotateConflicts: conflicting catalog claim becomes unresolved.
    const conflictingCatalog = { ...catalogItem(), catalog: { ...catalogItem().catalog, price: 299 } };
    const combined = buildClaimsFromEvidence([catalogItem(), conflictingCatalog]);
    const conflicts = [{ key: 'wine-42:price', values: ['249', '299'] }];
    const annotated = annotateConflicts(combined, conflicts);
    const withConflict = annotated.find((claim) => claim.kind === CLAIM_KINDS.UNRESOLVED_OR_CONFLICTING);
    assert.ok(withConflict, 'conflicting claim must be re-classified as unresolved_or_conflicting');
    assert.deepStrictEqual(withConflict.conflict.values, ['249', '299']);

    // Non-conflicting claims stay untouched.
    const cleanClaims = annotateConflicts(buildClaimsFromEvidence([documentItem()]), conflicts);
    assert.strictEqual(cleanClaims[0].kind, CLAIM_KINDS.DOCUMENT_SUPPORTED_FACT);
    assert.strictEqual(cleanClaims[0].conflict, null);

    // summarizeFreshness surfaces dynamic presence + newest timestamp.
    const summary = summarizeFreshness(claims, true);
    assert.strictEqual(summary.freshness_sensitive, true);
    assert.strictEqual(summary.dynamic_fields_present, true);
    assert.strictEqual(summary.synced_through, '2026-08-01T00:00:00.000Z');

    const staticSummary = summarizeFreshness(buildClaimsFromEvidence([documentItem()]), false);
    assert.strictEqual(staticSummary.dynamic_fields_present, false);
    assert.strictEqual(staticSummary.synced_through, null);

    // rankClaims orders strongest first.
    const ranked = rankClaims([webItem(), documentItem(), catalogItem(), canonicalItem()].map((item, i) => {
        const claim = buildClaimsFromEvidence([item])[0];
        claim.id = `claim_${i + 1}`;
        return claim;
    }));
    assert.strictEqual(ranked[0].kind, CLAIM_KINDS.VERIFIED_FACT);
    assert.strictEqual(ranked[1].kind, CLAIM_KINDS.LIVE_CATALOG_FACT);
    assert.strictEqual(ranked[2].kind, CLAIM_KINDS.DOCUMENT_SUPPORTED_FACT);
    assert.strictEqual(ranked[3].kind, CLAIM_KINDS.CURRENT_WEB_FACT);

    // No evidence → empty.
    assert.deepStrictEqual(buildClaimsFromEvidence([]), []);
    assert.deepStrictEqual(annotateConflicts([], [{ key: 'a', values: ['1'] }]), []);
    assert.strictEqual(conflictKeyForItem(null), null);

    console.log('claimProvenance: all assertions passed');
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = { run };
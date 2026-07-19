# Schema

Storage: Neon Postgres — **live**: project `seeds` (`empty-dream-97168511`,
us-west-2, PG 17), database `neondb`, connection string in `.env`
(`DATABASE_URL`). Applied 2026-07-16.

Two-layer model — `product` is what a retailer says (kept verbatim per
source), `strain` is the canonical merged entity the UI searches. Lineage is
a parent-edge graph so ancestry queries can count duplicate ancestors (e.g.
Chemdog appearing on both sides of a cross).

Note: `product` also carries the per-source strain measurements
(`lineage_text`, `indica_pct`/`sativa_pct`, `varietal`, THC/CBD ranges,
`effects`/`medical`/`flavors`/`terpenes` arrays) — each retailer reports its
own values; the strain-merge phase reconciles them into `strain`. The DDL
below shows `strain`; `product` mirrors those measurement columns.

## TypeScript interfaces

```typescript
type Source = 'blimburn' | 'seedsman';
type SeedSex = 'feminized' | 'regular' | 'unknown';
type FloweringType = 'photoperiod' | 'autoflower' | 'unknown';
type ParentSide = 'mother' | 'father' | 'unknown';

/** Canonical strain — merged across sources, what the UI searches. */
interface Strain {
  id: string;                       // uuid
  canonicalName: string;            // normalized display name
  aliases: string[];                // "Chemdog", "Chem Dawg", "Chemdawg", ...
  lineageText: string | null;       // raw cross expression, e.g. "(Biscotti x Jealousy) x (Sherb Bx)"
  indicaPct: number | null;         // Blimburn gives exact split
  sativaPct: number | null;
  varietal: 'indica-dominant' | 'sativa-dominant' | 'balanced' | null; // derivable / Seedsman bucket
  thcMinPct: number | null;         // range: Blimburn exact; Seedsman bucket mapped to coarse range
  thcMaxPct: number | null;
  cbdMinPct: number | null;
  cbdMaxPct: number | null;
  effects: string[];                // normalized vocab: relaxed, happy, energetic, ...
  medical: string[];                // stress, depression, pain, ...
  flavors: string[];                // banana, fruity, spicy, ... (Seedsman "aroma" merges here)
  terpenes: string[];               // myrcene, caryophyllene, ... (Blimburn only, mostly)
  createdAt: string;
  updatedAt: string;
}

/** Parent edge in the lineage graph. One row per parent occurrence. */
interface StrainParent {
  childStrainId: string;
  parentStrainId: string;
  side: ParentSide;                 // which side of the cross
  position: number;                 // ordinal within side, for >2-way crosses
  source: Source;                   // who claimed this parentage
  confidence: 'stated' | 'parsed-prose'; // spec-table cross vs. parsed from description text
}

/** A retailer listing — source of truth per site, never merged/overwritten. */
interface Product {
  id: string;                       // uuid
  source: Source;
  sourceId: string;                 // WooCommerce id / Magento sku
  sku: string;
  name: string;
  url: string;
  strainId: string | null;          // resolved canonical strain (null until matched)
  breeder: string | null;           // Seedsman only
  sex: SeedSex;
  floweringType: FloweringType;
  floweringWeeksMin: number | null;
  floweringWeeksMax: number | null;
  harvestMonthNorth: string | null;
  harvestMonthSouth: string | null; // Seedsman only
  climates: string[];
  heightCm: number | null;          // Blimburn exact
  yieldIndoorGm2Min: number | null; // grams per m²; Seedsman buckets map to ranges
  yieldIndoorGm2Max: number | null;
  yieldOutdoorGPlantMin: number | null;
  yieldOutdoorGPlantMax: number | null;
  description: string;              // plain text, for full-text search
  raw: unknown;                     // full source payload (JSONB) — reprocess without refetching
  contentHash: string;              // detect changes on incremental sync
  firstSeenAt: string;
  lastSeenAt: string;               // stale products (delisted) detectable
}
```

## Postgres DDL (indexes are the point)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE strain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL UNIQUE,
  aliases text[] NOT NULL DEFAULT '{}',
  lineage_text text,
  indica_pct numeric, sativa_pct numeric,
  varietal text,
  thc_min_pct numeric, thc_max_pct numeric,
  cbd_min_pct numeric, cbd_max_pct numeric,
  effects text[] NOT NULL DEFAULT '{}',
  medical text[] NOT NULL DEFAULT '{}',
  flavors text[] NOT NULL DEFAULT '{}',
  terpenes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- facet filtering: effects ∩ medical ∩ flavors
CREATE INDEX strain_effects_gin  ON strain USING gin (effects);
CREATE INDEX strain_medical_gin  ON strain USING gin (medical);
CREATE INDEX strain_flavors_gin  ON strain USING gin (flavors);
CREATE INDEX strain_terpenes_gin ON strain USING gin (terpenes);
-- range filters
CREATE INDEX strain_thc ON strain (thc_max_pct, thc_min_pct);
CREATE INDEX strain_cbd ON strain (cbd_max_pct, cbd_min_pct);
-- fuzzy name / lineage substring ("anything with Jealousy in the cross text")
CREATE INDEX strain_name_trgm    ON strain USING gin (canonical_name gin_trgm_ops);
CREATE INDEX strain_lineage_trgm ON strain USING gin (lineage_text gin_trgm_ops);

CREATE TABLE strain_parent (
  child_strain_id  uuid NOT NULL REFERENCES strain(id),
  parent_strain_id uuid NOT NULL REFERENCES strain(id),
  side text NOT NULL DEFAULT 'unknown',       -- mother | father | unknown
  position int NOT NULL DEFAULT 0,
  source text NOT NULL,
  confidence text NOT NULL DEFAULT 'stated',
  PRIMARY KEY (child_strain_id, parent_strain_id, side, position, source)
);
CREATE INDEX strain_parent_by_parent ON strain_parent (parent_strain_id);

CREATE TABLE product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_id text NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  strain_id uuid REFERENCES strain(id),
  breeder text,
  sex text NOT NULL DEFAULT 'unknown',
  flowering_type text NOT NULL DEFAULT 'unknown',
  flowering_weeks_min numeric, flowering_weeks_max numeric,
  harvest_month_north text, harvest_month_south text,
  climates text[] NOT NULL DEFAULT '{}',
  height_cm numeric,
  yield_indoor_gm2_min numeric, yield_indoor_gm2_max numeric,
  yield_outdoor_gplant_min numeric, yield_outdoor_gplant_max numeric,
  description text NOT NULL DEFAULT '',
  description_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', description)) STORED,
  raw jsonb NOT NULL,
  content_hash text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

-- full-text over descriptions
CREATE INDEX product_desc_fts ON product USING gin (description_tsv);
CREATE INDEX product_strain   ON product (strain_id);
```

## strain_ancestry — materialized closure (powers the search)

Precomputed by `sync/build-ancestry.mjs` (recursive walk, depth < 8) from
`strain_parent`. One row per reachable (descendant, ancestor) pair — 77k rows,
covering ~3,240 strains. Holds all three ranking algorithms as columns so the
search switches between them with an indexed lookup, no recompute.

```sql
CREATE TABLE strain_ancestry (
  descendant_id uuid, ancestor_id uuid,
  contribution numeric, -- Σ path weights = genetic share (direct-parent heavy)
  occurrences int,      -- # distinct paths = raw recurrence (depth-blind)
  sides int,            -- distinct parent-branches the ancestor enters from
  convergence numeric,  -- (T² − ΣBk²)/2 = Wright cross-side product (line/inbreeding)
  min_depth int,
  PRIMARY KEY (descendant_id, ancestor_id)
);
-- indexes: (ancestor_id, <metric> DESC) for each metric, + (descendant_id)
```

**The three algorithms (pluggable):** add a 4th by adding a column here + one
entry in `ALGORITHMS` in `ui/server.mjs`; API and UI pick it up automatically.
- `contribution` — genetic share. Direct parent = 50%. "How much X is this?"
- `convergence` — Wright cross-side product; only nonzero when an ancestor
  reaches the strain from ≥2 parent-sides. Detects line/back-crossing (BX/RBX/
  Fast/self-cross strains rank top — validated by their own names). "Bred back
  into itself." Uses product-of-both-sides weighting so deep shared ancestors
  nearly vanish (kills the big-pedigree confound).
- `occurrences` — raw path multiplicity, depth-blind. Dominated by deep
  foundational strains.

Endpoints: `/api/ancestor-search` (find strains descended from ancestor(s),
ranked by chosen algorithm, combinable with all facet filters; multiple
ancestor_ids are summed = the user-driven alias merge, e.g. Chemdog + Chemdawg
+ Chem Dawg), `/api/lineage?strain_id=&alg=` (per-strain breakdown),
`/api/strain-suggest` (ancestor autocomplete with descendant counts).

## The lineage query ("Chemdog twice in Berry Bliss")

Recursive CTE walks every ancestry path; an ancestor reachable by two paths
(both sides of a cross) yields two rows — `COUNT(*)` is the occurrence count.
`path` guard handles cycles from dirty data.

Each path also carries a generation-decayed weight — an estimated **genetic
contribution**. A strain inherits `1 / parent_count` from each parent (0.5 for
a normal two-parent cross), compounding down the path. Chemdog at depth 2 via
both sides = 0.25 + 0.25 = **0.5 contribution** — "half Chemdog" even though
it's never a direct parent.

```sql
WITH RECURSIVE ancestry AS (
  SELECT sp.parent_strain_id, 1 AS depth,
         ARRAY[sp.child_strain_id, sp.parent_strain_id] AS path,
         1.0 / pc.n AS weight
  FROM strain_parent sp
  JOIN LATERAL (SELECT COUNT(*)::numeric n FROM strain_parent
                WHERE child_strain_id = sp.child_strain_id) pc ON true
  WHERE sp.child_strain_id = (SELECT id FROM strain WHERE canonical_name = 'Berry Bliss')
  UNION ALL
  SELECT sp.parent_strain_id, a.depth + 1, a.path || sp.parent_strain_id,
         a.weight / pc.n
  FROM strain_parent sp
  JOIN ancestry a ON sp.child_strain_id = a.parent_strain_id
  JOIN LATERAL (SELECT COUNT(*)::numeric n FROM strain_parent
                WHERE child_strain_id = sp.child_strain_id) pc ON true
  WHERE NOT sp.parent_strain_id = ANY(a.path)   -- cycle guard
    AND a.depth < 15
)
SELECT s.canonical_name,
       COUNT(*)      AS occurrences,          -- 2 = shows up from both sides
       SUM(a.weight) AS genetic_contribution, -- generation-weighted share
       MIN(depth)    AS closest_generation
FROM ancestry a JOIN strain s ON s.id = a.parent_strain_id
GROUP BY s.canonical_name
ORDER BY genetic_contribution DESC;
```

Caveat: this assumes each cross splits contribution evenly among listed
parents. Backcrosses (Bx) and pheno selections skew real genetics — treat the
number as a ranking signal, not lab truth. (A backcross listed as
`Child x Parent` still weights correctly-ish since the repeated parent
accumulates from both paths.)

The inverse ("all descendants of Chemdog, weighted") is the same CTE walked
downward. At ~3,600 strains these queries are sub-millisecond; no closure
table needed.

## Known hard parts

1. **Name normalization** — "Chemdog" / "Chem Dawg" / "Chemdawg #91" must
   resolve to one strain node or occurrence counting silently breaks. Plan:
   normalize (lowercase, strip punctuation/spaces) + alias table + pg_trgm
   similarity review queue for near-misses. This is the highest-risk piece of
   the whole system; parser writes `confidence` so bad merges can be unwound.
2. **Lineage parsing** — cross expressions nest: `(Biscotti x Jealousy) x (Sherb Bx)`.
   Parse to a binary tree; sub-crosses that aren't named products become
   anonymous strain nodes (canonical_name = the expression) so the graph stays walkable.
3. **Bucket → range mapping** — Seedsman THC/yield buckets ("Very High THC 25%+")
   map to coarse ranges; exact values from Blimburn or `seeds_thc` win when present.
```

---

# Kindred product model (designed 2026-07-19, not yet built)

The strain is the hub. Everything sorts into three layers pivoting on it:
**Identity** (what a thing is), **Availability** (how you get it), **Experience**
(what happened to you). The existing `strain` + `strain_parent` + `strain_ancestry`
tables above ARE the identity core; the following extend it.

## Identity — Strain + Product

`strain` already exists (canonical genetics + lineage). New sibling for
manufactured goods:

```typescript
// A branded consumable that is NOT simple flower — edibles, carts, distillate.
// Flower does NOT get a Product row: flower = Strain + a flower Offering.
// May link to a strain, or not (distillate blends, "sativa gummy" have none).
interface Product {
  id: string;
  brand: string;
  name: string;
  category: 'edible' | 'cart' | 'concentrate' | 'preroll' | 'other';
  strainId: string | null;         // null = blend / no single strain
  cannabinoids: CannabinoidProfile; // the product's own measured profile
}

// Fuller than the current THC/CBD-only columns (borrowed from pheno.ai).
interface CannabinoidProfile {
  thcPct: number | null; cbdPct: number | null;
  cbgPct: number | null; cbnPct: number | null;
}
```

## Availability — Offering

*How/where you can get a strain or product.* Seed packs and dispensary flower
are both offerings; so are dispensary edibles/carts.

```typescript
interface Offering {
  id: string;
  targetStrainId: string | null;  // flower/seed point at a strain
  targetProductId: string | null; // edible/cart point at a product
  source: string;                 // 'blimburn' | 'seedsman' | dispensary slug
  type: 'seed' | 'flower' | 'edible' | 'cart' | 'concentrate';
  rawListedName: string;          // menu/listing name before decode ("Modified Blackberry Moonshine")
  price: number | null;
  size: string | null;            // "3.5g" | "10-pack fem"
  inStock: boolean | null;
  location: string | null;        // dispensary address/region
  url: string | null;
  lastSeenAt: string;
}
```

`rawListedName` → canonical strain resolution reuses the alias/review-queue
machinery. Three decode outcomes: **confident match** → alias to existing strain;
**confident novel** → mint an opaque canonical strain (journalable, no lineage,
reconcilable later); **uncertain** → mint provisionally + enqueue for review.
"Grow vs buy" on the landing page is just filtering offerings by `type`.

## Experience — Session / Intake / Outcome

A journal entry is a **Session**; it can hold **multiple Intakes** (flower + edible
together). Outcomes attach to the session as a whole.

```typescript
interface Session {
  id: string;
  userId: string;                 // always "me" for now; the multi-user seam
  occurredAt: string;
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night' | null;
  notes: string | null;
}

interface Intake {
  id: string;
  sessionId: string;
  strainId: string | null;        // for lineage recs; null if truly unknown/blend
  productId: string | null;       // the specific SKU, if a manufactured good
  form: 'flower' | 'vape' | 'edible' | 'concentrate' | 'preroll';
  dose: string | null;            // freeform for now ("1 bowl", "10mg")
  thcPct: number | null;          // batch-actual, captured on intake (no batch entity yet)
  isPrimary: boolean;             // the "main event" of a mixed session
}

interface Outcome {
  sessionId: string;
  domain: DomainKey;              // pain, sleep, calm, euphoria, energy, focus, appetite, enjoyment, + adverse
  score: number;                 // 0–5
}
```

**Attribution:** a strain earns a domain's credit from the sessions it appears in,
weighted `1/intakeCount` (or full weight if `isPrimary`). Solo sessions are the
clean signal; mixed ones count softer. Strain-less blends feed *product* insight,
not lineage recs. `form` on the intake gives free "this strain as flower vs edible"
slicing.

## Dimensions have THREE provenances — never conflated

The same `DomainKey` vocabulary (pain, sleep, euphoria…) carries data from three
distinct sources. **They are different types and must display separately:**

| Provenance | Source | Type | Where it lives |
|---|---|---|---|
| **Listed** | retailer/dispensary listing | categorical tag (present/absent) | per-source; disagreements are signal, not averaged away |
| **Mine** | my journal | 0–5 score | `Outcome` rows where `userId = me` |
| **Community** | other users' journals | 0–5 aggregate | derived view over `Outcome` across users |

```typescript
// Listed claim, kept PER SOURCE — Blimburn and a dispensary can disagree on the
// same strain, and that gap is worth showing.
interface ListedTrait {
  strainId: string;
  domain: DomainKey;
  source: string;
  present: boolean;              // listings are categorical, not scored
}

// Community = derived aggregate; never exposes an individual's rows.
interface CommunityScore {
  strainId: string;
  domain: DomainKey;
  avgScore: number;              // 0–5
  nUsers: number;
}
```

Display: `Pain — Listed: ✓ (Blimburn, 2 dispensaries) · You: 4.2 (3) · Community: 3.6 (14)`.
Listed shows as a tag; You/Community as 0–5. The gap between claimed and felt is
a headline feature.

## Recommendation = the ancestry engine, input swapped

"Strains you might like" for a domain = take the strains that scored high in that
domain, walk their lineage/effect overlap (the `strain_ancestry` closure +
contribution/convergence), surface untried kindred strains. **Personal vs community
is one toggle:** `WHERE userId = me` vs `WHERE userId = anyone` on the input set —
same engine.

## Multi-user seam (design now, build later)
`userId` on `session`/`outcome` from day one (constant "me"). Community is a
derived aggregate that never exposes individuals. Real accounts / auth / privacy /
moderation are a deferred phase — the schema just never precludes them.

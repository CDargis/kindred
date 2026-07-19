# Decisions

## 2026-07-19 — `seeds` becomes **Kindred**; abandon pheno.ai; product design

**Rename/reframe.** `seeds` was only ever the strain-data + lineage engine. The
real product is "find the strain you'll like — to grow or buy — by what you feel,
traced through genetics." Named **Kindred** (strains *kindred* to what you like =
the ancestry-overlap mechanic). Cannabis signaled via branding, not spelling
(rejected "Cindred"/"Mindred"). Domain `kindred.chrisdargis.com`.

**Abandon pheno.ai, fold into Kindred.** pheno.ai (planning-stage Go/Neon backend)
was independently building the *same* lineage graph + ancestry-overlap recommender
on the same Neon Postgres — a live duplication. Its only non-redundant idea is
**journaling/outcomes**, which is additive. Decision: crown the working `seeds`
engine as the foundation, carry over journaling + a few schema bits (`FamilyTags`,
enrichment-status, fuller cannabinoid profile) + its Seed City scraper, drop the
rest. Archive the pheno.ai repo for salvage.

**Stay Node.** Kept the working engine; dropped pheno's Go serving rewrite.
Ingestion (Node) + serving (Node/Express → Lambda) over shared Neon. Accepted
tradeoff: serving diverges from grow's Go/Lambda, fine for a solo tool.

**Deploy: AWS serverless like grow, not self-hosted.** Lambda + Function URL +
CDK, cost-tagged `Project=kindred` (app-root tag, grow's pattern), us-east-1,
acct 853479287330. Must be up when the phone needs it (rules out self-hosting on
the machine like couch.cast). Single-password auth, long-lived signed cookie.

**Product data model** (see schema.md "Kindred product model"). Key calls:
- **Strain = hub.** Identity (Strain/Product) · Availability (Offering) ·
  Experience (Session/Intake/Outcome), all pivoting on the strain.
- **Flower = Strain + Offering**, no Product row; only manufactured goods
  (edibles/carts/blends) are Products; strain-less blends journalable but skip
  lineage recs.
- **Three provenances, never conflated:** Listed (per-source categorical tag,
  disagreements shown not averaged) vs Mine (0–5 journal) vs Community (0–5
  derived aggregate). The claimed-vs-felt gap is a headline feature.
- **Sessions hold multiple intakes** (flower + edible); outcomes attach to the
  session, strain credit weighted `1/intakeCount` or `isPrimary`.
- **Strain-less decode:** confident match → alias; confident novel → mint opaque
  strain (so community data can accrue); uncertain → mint + review queue.
- **Batch:** strain-level for now; batch THC as a plain intake field.
- **Multi-user seam now, build later:** `userId` on sessions/outcomes (constant
  "me"); community = derived aggregate; personal↔community recs = one input toggle.
- Outcome scale 0–5. Domains: pain, sleep, calm, euphoria, energy, focus,
  appetite, enjoyment ("just like it") + adverse.

## 2026-07-19 — Curation overlay + self-cross convergence fix

**Curation overlay** (`sync/curation.mjs`) — persistent hand-corrections applied
on every graph rebuild (products stay source of truth):
- `SUPPLEMENTAL_LINEAGE` — real lineages for retailer dead-end leaves. Seeded:
  Tres Dawg = Chem D × (Afghani × Chem D); Headband = OG Kush × Sour Diesel;
  East Coast Sour Diesel = Sour Diesel (selection). Tres Dawg alone lifted
  Stardawg from ~17% → 75% Chemdog-line.
- `ALIAS_MERGE` — collapse spelling variants of the SAME cut. Base Chemdog =
  chemdawg/chem dawg/chemdowg/chemdwag → chemdog. Distinct cuts consolidated to
  canonical cut keys but kept SEPARATE from base and each other: #4 (chemdog 4),
  '91 (chemdog 91), Chem D. **Rule: merge misspellings; never flatten cuts.**
  (Chris flagged Chemdog #4 ≠ Chemdog — cuts are sibling phenos from the
  original seed line, distinct.)
- `FAMILIES` — umbrella grouping (chemdog family = base + #4 + 91 + D) for
  "how much of this LINE" queries without flattening. Query-side via multi-
  select ancestor picker.
Applied in `build-lineage.mjs` via `applyAlias()` + supplemental ingest.

**Self-cross convergence fix** (`build-ancestry.mjs`) — branch is now keyed by
cross POSITION, not parent identity. A self-cross (X × X) has the same node on
both sides; keying by parent id collapsed it to one branch → convergence 0,
which is backwards (a self-cross is *maximal* inbreeding). Position-based branch
gives identical results for normal crosses and correctly scores self-crosses.
Stardawg Regular (Stardawg × Stardawg) went 0 → 0.05 convergence, surfacing as
a top "intensified Chemdog" pick. Closure grew 77k → 100k rows; converging
pairs 8.4k → 13.9k; max convergence 0.25 → 0.33.

**Note:** `build-lineage.mjs` now also clears `strain_ancestry` before wiping
strains (FK dependency).

## 2026-07-17 — Convergence theory validated; multi-algorithm ancestry search

Chris's core theory: a strain being **crossed back into itself** (an ancestor
recurring on multiple independent branches) is a distinct, meaningful signal —
different from raw genetic share. Gut-checked and it holds up:
- **Biologically grounded** — this is Sewall Wright's coefficient of inbreeding.
  Backcrossing/selfing (the BX/S1/RBX all over the data) raises homozygosity,
  which *fixes/intensifies* an ancestor's traits (with inbreeding-depression as
  the counter-limit). Not fringe.
- **Empirically real** — the tightened metric (Wright cross-side product,
  `(T²−ΣBk²)/2`) ranks strains whose **names literally declare backcrossing** at
  the top: "X × X", "…RBX", "…BX1", "Fast Version". The algorithm independently
  rediscovered the backcrossed strains. Confound (popular strains have deeper
  documented pedigrees → more apparent convergence) largely removed by the
  product weighting; can't fully eliminate with retailer text.

**Decision: ship 3 pluggable ranking algorithms, switchable in search**, not one
"right" metric — contribution (genetic share), convergence (Wright/inbreeding,
the theory), occurrences (raw recurrence). Precomputed into `strain_ancestry`
(see schema.md); adding a 4th (e.g. explicit self/backcross detector) is a
column + a config entry. Alias fragmentation (Chemdog/Chemdawg/…) handled
user-side for now via multi-select ancestor picker that sums across spellings;
proper fix is still the review-queue curation (task).

## 2026-07-16 — Lineage graph built (v1)

`sync/build-lineage.mjs` parses every product's `lineage_text` into a strain
parent-edge graph. Recursive-descent parser (`sync/lib/lineage.mjs`) handles
nested `()`/`[]`, `x`/`X`/`×`/"crossed with", "Name (expansion)" sub-crosses,
and skips prose (landrace descriptions). Normalization strips retail suffixes
("Feminized Seeds", "- 5" pack markers), blocklists placeholders (Hybrid,
Unknown, F1–F6…) while keeping real short names (OG, AK, NL, GG), and sorts
cross-node keys so reciprocal crosses (A×B / B×A) merge. Result: **5,394
strains, 6,993 edges** from 3,637 products.

Weighted ancestry query (in `ui/server.mjs` `/api/lineage`): each hop divides
contribution by parent count, so an ancestor reachable via multiple paths sums
its shares ("½ Chemdog"). Occurrence count = distinct genealogical paths.
UI "genetic breakdown" panel renders it as a contribution bar chart.

**Accuracy ceiling is name resolution** (the known hard part). Aliases like
Chemdawg / Chem Dawg / Kush Chemdog fragment a strain's true contribution
across nodes. Mitigation: `strain_name_review` table holds pg_trgm near-miss
pairs (sim 0.72–0.97, **1,033 pairs**) as a human review/merge queue — this is
ongoing curation, task #7. Graph rebuilds fresh from products each run
(products = source of truth), so merges must be applied as alias rules, not
hand-edits to strain rows.

## 2026-07-16 — Additional-source recon

Probed 8 retailers for open APIs + data richness:
- **North Atlantic Seed Co** — WooCommerce, open Store API, **3,273 products**,
  huge US breeder breadth (Tiki Madman, LIT Farms, Fast Buds, boutique drops).
  Structured attrs: Seed Type (sex), Growth Type (photo/auto), Pack Size;
  breeder from categories. Descriptions moderate — ~half have parseable
  lineage, THC rare. **Breadth play; same trivial pattern as Blimburn.**
- **MSNL** (marijuana-seeds.nl) — Magento; size TBD; possible richer depth.
- **Crop King** — WooCommerce, Store API 200 but catalog size unconfirmed.
- **ILGM, Royal Queen Seeds, Herbies, Fast Buds, Barney's Farm** — custom/Next
  frontends, no `/products.json`; would need per-page HTML scraping (harder).

Recommendation: **NASC** — biggest catalog, open API, complements existing
data (US availability + boutique breeders Blimburn/Seedsman lack). Effort is
low (clone the Blimburn WooCommerce module). Depth is its weakness; lineage
parse reuses the existing `lineage.mjs`.

### Follow-up recon — Homegrown & RQS (Chris's picks)
- **Homegrown Cannabis Co** (homegrowncannabis.com, note: not `...co.com`) —
  Magento but **GraphQL disabled (404)** and REST products needs auth, so **no
  open bulk API**. Path is sitemap → **437 server-rendered product pages**
  under `/products/`. Pages are data-rich: THC/CBD, flowering, yield, harvest,
  height, genetics, **effects, terpenes**, indica/sativa, plus JSON-LD (reviews
  parse; Product LD block is oversized/malformed — parse the spec DOM instead,
  like Blimburn PDPs). Single house brand (own genetics), US-focused.
- **Royal Queen Seeds** — also Magento-ish, GraphQL 404, REST 404 (**more
  locked down than Homegrown**), PrestaShop-style `.html` product URLs. Also
  HTML-scrape-only. Single breeder, ~250 strains.

**Neither is "API-easy" like NASC.** Both need a per-page HTML crawl + a custom
spec-DOM parser (same class of work as Blimburn's PDP table). Between them
Homegrown wins: richer data (effects/terpenes/genetics), more products (437 vs
~250), server-rendered. **If building an HTML-scrape source: do Homegrown.**
**If optimizing for least effort: do NASC (open API).**

## 2026-07-16 — Storage: Neon Postgres; UI: Angular; runtime: Lambda + CDK

**Access patterns:** faceted search (effects/medical/flavors/THC-CBD ranges),
lineage ancestry queries including duplicate-ancestor counting (e.g. Chemdog
appearing on both sides of a cross), full-text over descriptions,
cross-retailer strain views. A search UI (Angular) is wanted.

**Storage: Neon Postgres** over DynamoDB — ad-hoc faceted/substring/recursive
queries are Postgres's game; ~3,600 products (~5MB) fits free tier, scales to
zero. Lineage stored as a parent-edge graph (`strain_parent`), ancestry via
recursive CTE — duplicate ancestors fall out naturally as path counts.
See schema.md.

**Runtime:** CDK stack — EventBridge nightly cron → sync Lambda (Node fetch,
`Promise.all` batches of ~4-5 for Blimburn PDPs; no SQS until proven needed).
Initial 35-min backfill runs once locally to seed the DB; the cron only does
deltas (~50 requests, <2 min) using `content_hash` + listing diffs.

## 2026-07-16 — Scrape via public APIs, not browser automation

**Context:** Assumed we'd need Selenium and that the sites might block scraping.
Ran a feasibility spike first.

**Findings:**

### Blimburn (WooCommerce / WordPress)
- Public Store API: `https://blimburnseeds.com/wp-json/wc/store/v1/products?per_page=100&page=N`
- 1,373 products total (`X-WP-Total` header), so ~14 requests for the full catalog list.
- Description HTML (in the API) has lineage/THC/effects as prose under
  consistent headings (`<h2>Lineage…`, `Origin`, …).
- **The good stuff is only in the product detail page HTML**, not in any JSON
  API (checked Store API `extensions`, WP REST `meta`/`acf`/`content` — all
  empty). Each PDP has a clean key/value spec table (`bbs-cp-info-table`):
  THC exact % range, Lineage (exact cross), Type, Climate, Harvest Month,
  Height, Yield (qualitative + exact indoor oz/ft²·g/m² + outdoor oz/plant),
  Flowering Time, Phenotype (indica/sativa % split), **Medical** (Stress,
  Depression, Pain…), **Effects**, **Flavors**, **Terpenes** (named).
  Also a 3-group icon block (Flavors/Effects/Medical) duplicating the table.
- So Blimburn = 14 listing requests + ~1,373 PDP fetches (~35 min at 1.5s delay).
  Table parse is trivial (label/value cells).

### Seedsman (Magento 2)
- Public GraphQL endpoint: `https://www.seedsman.com/graphql` — no auth, no
  store header needed. Introspection disabled, but standard Magento schema works.
- Full catalog: `products(filter:{category_uid:{eq:"Mjk="}}, pageSize:100, currentPage:N)`
  → 2,265 products, 23 pages. (`Mjk=` = "Cannabis Seeds" root category.)
- **Fully structured attributes via ScandiPWA's `s_attributes` field** (found by
  reading their frontend bundle; works in bulk listing queries too):
  `products(...){items{sku s_attributes{attribute_code attribute_label
  attribute_value attribute_type attribute_options{value label}}}}`.
  Select-type values are option IDs — resolve via `attribute_options`.
- Attribute inventory with coverage (100-product mid-catalog sample):
  `genetic_description` "Parental lines" = lineage (96%), `seeds_variety`
  (indica/sativa dominance), `seeds_flowering_type` (99), `seeds_feminised` (99),
  `seeds_climate` (98), `seeds_yield_indoor_filter` (94), `seeds_taste_filter`
  "Aroma" (88), `seeds_odour` (84), `seeds_thc_filter` bucket (75),
  `seeds_yield_filter` outdoor bucket (67), `seeds_flowering_time` (58),
  `seeds_thc` exact (50), `seeds_extracts` (48), `seeds_auto_harvest_time` (38),
  `seeds_bud_formation` (33), `seeds_cbd_filter` (29), `seeds_harvest_month` (26),
  `lab_report` (14), `seeds_mould` (4), `seeds_effect_filter_2` "Effect"
  (~15% catalog-wide — sparse!), `seeds_terpenes_filter` (~1%), plus breeder
  (`brand`), awards, COA files, N+S hemisphere harvest months.
- Category facet memberships (Effect/Climate/Genetics/… via `categories` +
  `breadcrumbs`) duplicate the sparse filter attributes — same coverage.
- Lineage also appears as prose in `description.html`.
- Exact lookup by SKU works; `url_key` filter is unreliable (returned wrong
  product — appears to fall back to fuzzy search). Empty `search:""` errors —
  must filter by category or search term.
- Category tree with uids/product counts: `{categoryList{...}}`.
- HTML pages are a client-rendered shell (~18KB) — GraphQL is the only viable
  path, and also the best one.

**Decision:** Plain HTTP (Node `fetch`) against these APIs. No Selenium/Playwright.
Keep a polite delay (~1–2s) between requests; full sync of both catalogs is only
~40 requests total, so this is cheap and low-profile.

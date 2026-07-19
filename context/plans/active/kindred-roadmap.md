# Kindred — Product Roadmap & Architecture

Status: active. Written 2026-07-19 when `seeds` became `Kindred`. The engine is
built; this plan covers turning it into the deployed, journaling product.

## Product in one line
Journal what you like and *why* → get genetically-kindred strain recommendations
→ acquire via seeds (grow) or dispensary (buy). See `context/overview.md`.

## Architecture

**Split by strength, one shared Neon Postgres:**
- **Ingestion (Node, built)** — scrapers + lineage parser + graph/ancestry/
  convergence builders + curation overlay. Runs offline/scheduled to populate
  the DB. `sync/`.
- **Serving (Node/Express)** — the app + API. Currently `ui/server.mjs` (local).
  Gets deployed to Lambda. Convergence "algorithms" are SQL (recursive CTEs +
  materialized `strain_ancestry`), so serving just queries them.
- **Frontend** — the current single-page `ui/index.html` is the interim UI.
  React/Vite (like `grow`) is the eventual target, not a blocker.

**Deploy:** AWS serverless mirroring `grow` — Lambda + Function URL (no API
Gateway cost) + CDK, account 853479287330 / us-east-1, cost-tagged
`Project=kindred` at the app root (Program-level tag, as grow does). Domain
`kindred.chrisdargis.com` via the existing R53 zone. Neon pooled URL as a Lambda
env/secret. Single-password auth with a long-lived HMAC-signed cookie (stay
logged in). No scheduled sync yet — run ingestion by hand for now.

## The UI: one strain hub, personal data as an overlay lens

Requirement: search strains *regardless* of journaling, but *see where they
intersect* it. Solution — personal layer is an overlay, not a separate mode.

Three surfaces sharing the strain hub:
1. **Explore** — objective strain search (facets, lineage, convergence). Works
   with zero journaling. Each strain shows a personal badge when it intersects
   you, in tiers: ★ journaled ("You: 4.2 sleep · 3 sessions") · ◈ kindred
   ("35% shared lineage with your #1 sleep strain") · ◇ profile-match (effect
   overlap). Toggle to filter to only-intersecting or rank by fit-to-profile.
2. **Journal** — your sessions/intakes/outcomes, sliceable by domain.
3. **For You** — per-domain recommendations from the ancestry engine ("best
   untried bets for pain"), with a **personal ↔ community** toggle.

Domains (pain, sleep, calm, euphoria, energy, focus, appetite, enjoyment, +
adverse) are the same vocabulary as a search facet, a journal axis, AND a
recommendation lens — that unification is what keeps the intersecting ideas coherent.

## Phased build

- **Phase 0 — Deploy the engine (next).** Auth + Lambda refactor of the Express
  app, serverless-express handler, CDK stack (Lambda + Function URL + cost tag),
  `kindred.chrisdargis.com`. Goal: the current search UI on the phone.
- **Phase 1 — Journaling.** Session/Intake/Outcome tables; log UI; the personal
  overlay badges on Explore; per-domain personal profile rollup.
- **Phase 2 — Recommendations.** "For You" per-domain, driven by ancestry
  overlap from journaled winners. Personal-only first.
- **Phase 3 — Dispensary source.** Offering model + a dispensary menu scraper;
  raw-name → canonical decode via the alias/review queue; grow-vs-buy filter.
- **Phase 4 — Community (seam already in).** Flip on multi-user: real accounts,
  CommunityScore aggregate view, personal↔community toggle, privacy/moderation.
- **Later — Angular/React frontend**, scheduled ingestion (EventBridge + Lambda),
  fuller cannabinoid enrichment.

## Open questions / to-resolve before each phase
- Dose: freeform string now; structured (mg / fraction) later?
- "For You" ranking: pure ancestry overlap, or blend with listed/effect similarity?
- Dispensary sources: which dispensaries first (local to Chicago)?
- Frontend framework when we leave the interim HTML: React (match grow) vs Angular
  (global default). Lean React for consistency with grow.

## Carried over from the abandoned pheno.ai
- Journaling/outcomes concept (this whole product layer).
- Schema bits: `FamilyTags`, enrichment-status pattern, fuller CannabinoidProfile.
- `research/scrape_seed_city.py` + strain CSV — a third seed source to fold in.

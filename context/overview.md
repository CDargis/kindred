# Kindred — Overview

**Find the cannabis strain you'll like — to grow or to buy — by what you actually
feel, traced through genetics.**

Kindred started as `seeds` (a scraper + lineage/convergence engine) and absorbed
the product vision from the abandoned `pheno.ai`: journal what you like and *why*
(pain relief, sleep, euphoric, "I just like it"), and it recommends genetically
**kindred** strains you haven't tried. Seeds (grow) and dispensary (buy) are two
acquisition surfaces over one strain engine.

## The loop
Journal what you liked + why → engine finds genetically-kindred strains (lineage
overlap + effect profile) → acquire via **seeds** (grow it) or **dispensary**
(buy it nearby) → journal that → repeat.

## Status (2026-07-19)
**Engine: built and working.** Neon Postgres; two seed sources scraped (Blimburn
1,373 + Seedsman 2,264 = 3,637 products); lineage graph (5,383 strains / 6,987
edges); materialized ancestry closure (100k rows) with three switchable ranking
algorithms — **contribution** (genetic share), **convergence** (Wright
inbreeding/line-breeding), **occurrences** — plus a curation overlay
(`sync/curation.mjs`) and a live local search UI (`ui/`, Node/Express).

**Product: designed, not built.** Data model + UI architecture for journaling,
provenance (listed vs mine vs community), acquisition (seed vs flower), and a
multi-user seam are specified in `context/schema.md` and
`context/plans/active/kindred-roadmap.md`. Next up: deploy the engine (Lambda),
then layer journaling.

## Decisions that shape it
- **Node, not Go.** Kept the working engine; dropped pheno.ai's Go rewrite.
- **Neon Postgres, not DynamoDB.** The convergence engine lives on recursive
  CTEs + GIN + trigram; Dynamo can't serve it.
- **AWS serverless like `grow`** — Lambda + Function URL + CDK, cost-tagged
  `Project=kindred`, at `kindred.chrisdargis.com`. Not self-hosted (must be up
  when the phone needs it).
- Single-password auth now, real users later (seam left in the model).

## Sibling projects
- `grow` — shipped grow *journal* (plants you own). Different job; stays separate.
- `pheno.ai` — **abandoned**, folded into Kindred (archive for salvage).

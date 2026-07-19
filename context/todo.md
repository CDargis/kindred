# TODO

Project is now **Kindred** (was `seeds`). Full roadmap:
`context/plans/active/kindred-roadmap.md`.

## Engine — done
- ✅ Neon + schema; Blimburn + Seedsman scraped (3,637 products)
- ✅ Lineage graph (5,383 strains), materialized ancestry closure (100k rows)
- ✅ 3 ranking algorithms (contribution / convergence / occurrences)
- ✅ Curation overlay (`sync/curation.mjs`); self-cross convergence fix
- ✅ Local search UI (`ui/`, Node/Express)

## Phase 0 — Deploy the engine (NEXT)
- [ ] Auth + Lambda refactor: export Express app; single-password login with
  long-lived HMAC-signed cookie; protect routes
- [ ] serverless-express handler for Lambda Function URL
- [ ] CDK stack: Lambda + Function URL, env DATABASE_URL/APP_PASSWORD/SESSION_SECRET,
  `Project=kindred` cost tag, us-east-1
- [ ] `kindred.chrisdargis.com` (R53) + deploy; verify on phone

## Then (see roadmap for detail)
- Phase 1 Journaling · Phase 2 Recommendations · Phase 3 Dispensary source ·
  Phase 4 Community · later React frontend + scheduled sync

## Housekeeping
- [ ] Physical directory rename `seeds/` → `kindred/` (do when nothing is cwd'd in it)
- [ ] Init git repo + push (github.com/CDargis/kindred, matching grow)
- [ ] Archive `pheno.ai` repo; salvage `research/scrape_seed_city.py` + strain CSV
- [ ] Filter Seedsman non-seed merch (t-shirts) from the pull
- [ ] Extend curation to other foundational hubs (OG Kush, GSC, Sour Diesel)

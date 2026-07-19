// Backfill / sync: pull full catalogs from Blimburn + Seedsman into Neon.
//
// Usage:
//   npm run backfill                              # both sources, full catalog
//   npm run backfill -- --source=seedsman         # one source
//   npm run backfill -- --source=blimburn --limit=10   # smoke test
//
// Idempotent: upserts on (source, source_id); safe to re-run. Incremental
// change detection via content_hash is available to a future cron Lambda.

import * as blimburn from './lib/blimburn.mjs';
import * as seedsman from './lib/seedsman.mjs';
import { createPool, upsertProducts } from './lib/db.mjs';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
);

const limit = args.limit ? Number(args.limit) : Infinity;
const sources = { blimburn, seedsman };
const selected = args.source ? [args.source] : Object.keys(sources);

for (const name of selected) {
  if (!sources[name]) {
    console.error(`Unknown source "${name}". Valid: ${Object.keys(sources).join(', ')}`);
    process.exit(1);
  }
}

const pool = createPool();
const startedAt = Date.now();
let failed = false;

for (const name of selected) {
  console.log(`\n=== ${name} ===`);
  try {
    const { rows, errors: fetchErrors, warnings = [], expectedTotal } = await sources[name].fetchAll({ limit });
    if (expectedTotal && limit === Infinity && rows.length < expectedTotal * 0.9) {
      console.error(`[${name}] INCOMPLETE: got ${rows.length} of ~${expectedTotal} expected`);
      failed = true;
    }
    console.log(`[${name}] fetched ${rows.length} products, ${fetchErrors.length} fetch errors, ${warnings.length} warnings`);
    for (const e of fetchErrors.slice(0, 10)) {
      console.log(`  fetch error: ${JSON.stringify(e)}`);
    }
    for (const w of warnings.slice(0, 10)) {
      console.log(`  warning: ${JSON.stringify(w)}`);
    }
    const dbErrors = await upsertProducts(pool, rows);
    console.log(`[${name}] upserted ${rows.length - dbErrors.length}/${rows.length}, ${dbErrors.length} db errors`);
    for (const e of dbErrors.slice(0, 10)) {
      console.log(`  db error: ${JSON.stringify(e)}`);
    }
    if (fetchErrors.length + dbErrors.length > rows.length * 0.1) {
      failed = true; // more than 10% failures is a broken run, not noise
    }
  } catch (err) {
    console.error(`[${name}] FAILED:`, err);
    failed = true;
  }
}

const { rows: [counts] } = await pool.query(
  `SELECT source, COUNT(*) n FROM product GROUP BY source ORDER BY source`
).then((r) => ({ rows: [r.rows] }));
console.log(`\nDB totals:`, counts.map((r) => `${r.source}=${r.n}`).join(', ') || '(empty)');
console.log(`Done in ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);

await pool.end();
process.exit(failed ? 1 : 0);

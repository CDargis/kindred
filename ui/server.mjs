// Local strain explorer. Run: node --no-warnings --env-file=.env ui/server.mjs → http://localhost:3000
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from '../sync/lib/db.mjs';

const app = express();
const pool = createPool();
const dir = path.dirname(fileURLToPath(import.meta.url));

// Ancestry ranking algorithms → strain_ancestry column. Add a new algorithm by
// adding a column to the closure and one entry here; the API + UI pick it up.
const ALGORITHMS = {
  contribution: 'contribution', // genetic share (direct-parent heavy)
  convergence: 'convergence',   // Wright cross-side product (line/inbreeding)
  occurrences: 'occurrences',   // raw recurrence / multiplicity
};

app.get('/', (_req, res) => res.sendFile(path.join(dir, 'index.html')));

// --- shared product-filter builder (used by /search and /ancestor-search) ---
function productFilters(q, params) {
  const where = [];
  const add = (clause, value) => {
    params.push(value);
    where.push(clause.replaceAll('$N', '$' + params.length));
  };
  if (q.q) {
    add(`(p.description_tsv @@ plainto_tsquery('english', $N) OR p.name ILIKE '%' || $N || '%')`, q.q);
  }
  if (q.lineage) {
    add(`p.lineage_text ILIKE '%' || $N || '%'`, q.lineage);
  }
  for (const facet of ['effects', 'medical', 'flavors', 'terpenes']) {
    if (q[facet]) {
      add(`p.${facet} @> $N::text[]`, q[facet].split(',').map((s) => s.trim().toLowerCase()));
    }
  }
  if (q.thc_min) { add(`p.thc_max_pct >= $N`, Number(q.thc_min)); }
  if (q.thc_max) { add(`p.thc_min_pct <= $N`, Number(q.thc_max)); }
  if (q.source) { add(`p.source = $N`, q.source); }
  if (q.sex) { add(`p.sex = $N`, q.sex); }
  if (q.flowering) { add(`p.flowering_type = $N`, q.flowering); }
  return where;
}

const PRODUCT_COLS = `p.source, p.sku, p.name, p.url, p.breeder, p.sex, p.flowering_type,
  p.lineage_text, p.strain_id, p.indica_pct, p.sativa_pct, p.varietal,
  p.thc_min_pct, p.thc_max_pct, p.cbd_min_pct, p.cbd_max_pct,
  p.effects, p.medical, p.flavors, p.terpenes,
  p.flowering_weeks_min, p.flowering_weeks_max, p.yield_indoor_gm2_min, p.yield_indoor_gm2_max`;

// --- facets for filter UI ---
app.get('/api/facets', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT facet, value, COUNT(*)::int AS n FROM (
        SELECT 'effects'  AS facet, unnest(effects)  AS value FROM product UNION ALL
        SELECT 'medical'  AS facet, unnest(medical)  AS value FROM product UNION ALL
        SELECT 'flavors'  AS facet, unnest(flavors)  AS value FROM product UNION ALL
        SELECT 'terpenes' AS facet, unnest(terpenes) AS value FROM product
      ) f GROUP BY facet, value ORDER BY facet, n DESC
    `);
    const { rows: [meta] } = await pool.query(`SELECT COUNT(*)::int AS total FROM product`);
    const facets = {};
    for (const r of rows) { (facets[r.facet] ??= []).push({ value: r.value, n: r.n }); }
    res.json({ facets, meta });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- standard product search ---
app.get('/api/search', async (req, res) => {
  const q = req.query;
  const params = [];
  const where = productFilters(q, params);
  const sort = { name: 'p.name ASC', thc: 'p.thc_max_pct DESC NULLS LAST',
    yield: 'p.yield_indoor_gm2_max DESC NULLS LAST' }[q.sort] ?? 'p.name ASC';
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = 50;
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const { rows } = await pool.query(
      `SELECT ${PRODUCT_COLS}, COUNT(*) OVER ()::int AS total
       FROM product p ${whereSql}
       ORDER BY ${sort} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
    res.json({ total: rows[0]?.total ?? 0, page, pageSize, results: rows });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- ancestor autocomplete (only strains that ARE ancestors of something) ---
app.get('/api/strain-suggest', async (req, res) => {
  if (!req.query.q || req.query.q.length < 2) { return res.json({ suggestions: [] }); }
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.canonical_name AS name, d.cnt::int AS descendants
      FROM strain s
      JOIN (SELECT ancestor_id, COUNT(*) cnt FROM strain_ancestry GROUP BY ancestor_id) d
        ON d.ancestor_id = s.id
      WHERE s.canonical_name ILIKE '%' || $1 || '%'
      ORDER BY d.cnt DESC LIMIT 12`, [req.query.q]);
    res.json({ suggestions: rows });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- ancestry search, ranked by algorithm ---
// With ancestor_id(s): strains descended from that ancestor. Multiple comma-
// separated ids are summed — the user-driven way to merge alias spellings
// (Chemdog + Chemdawg + Chem Dawg) into one effective ancestor.
// Without ancestor_id: GLOBAL ranking — every strain scored by the chosen
// algorithm summed over ALL its ancestors (e.g. convergence = most linebred).
app.get('/api/ancestor-search', async (req, res) => {
  const q = req.query;
  const col = ALGORITHMS[q.alg] ?? 'convergence';
  const ancIds = String(q.ancestor_id ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const min = q.min != null ? Number(q.min) : 0;

  const params = [];
  const where = [];
  if (ancIds.length) {
    params.push(ancIds);
    where.push(`sa.ancestor_id = ANY($1::uuid[])`, `sa.descendant_id <> ALL($1::uuid[])`);
  }
  where.push(...productFilters(q, params));
  params.push(min);
  const minParam = '$' + params.length;
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const { rows } = await pool.query(`
      SELECT ${PRODUCT_COLS},
             round(SUM(sa.${col})::numeric, 4)::float AS score,
             round(SUM(sa.contribution)::numeric, 4)::float AS contribution,
             round(SUM(sa.convergence)::numeric, 4)::float AS convergence,
             SUM(sa.occurrences)::int AS occurrences,
             MIN(sa.min_depth) AS closest_gen,
             COUNT(*) OVER ()::int AS total
      FROM strain_ancestry sa
      JOIN product p ON p.strain_id = sa.descendant_id
      ${whereSql}
      GROUP BY p.id, ${PRODUCT_COLS}
      HAVING SUM(sa.${col}) >= ${minParam}
      ORDER BY score DESC
      LIMIT 100`, params);
    res.json({ algorithm: q.alg ?? 'convergence', global: !ancIds.length, total: rows[0]?.total ?? 0, results: rows });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- per-strain ancestry (the "genetic breakdown" panel), ranked by algorithm ---
app.get('/api/lineage', async (req, res) => {
  if (!req.query.strain_id) { return res.status(400).json({ error: 'strain_id required' }); }
  const col = ALGORITHMS[req.query.alg] ?? 'contribution';
  try {
    const { rows } = await pool.query(`
      SELECT s.canonical_name AS ancestor,
             round(sa.${col}::numeric, 4)::float AS score,
             round(sa.contribution::numeric, 4)::float AS contribution,
             round(sa.convergence::numeric, 4)::float AS convergence,
             sa.occurrences, sa.sides, sa.min_depth AS closest_gen
      FROM strain_ancestry sa
      JOIN strain s ON s.id = sa.ancestor_id
      WHERE sa.descendant_id = $1 AND sa.${col} > 0
      ORDER BY sa.${col} DESC LIMIT 60`, [req.query.strain_id]);
    res.json({ algorithm: req.query.alg ?? 'contribution', ancestors: rows });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

const port = process.env.PORT ?? 3000;
app.listen(port, () => console.log(`seeds explorer → http://localhost:${port}`));

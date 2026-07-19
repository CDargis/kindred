// Materialize the strain_ancestry closure from the strain_parent graph.
// Run after build-lineage.mjs: node --no-warnings --env-file=.env sync/build-ancestry.mjs
//
// For every (descendant, ancestor) pair reachable within MAX_DEPTH hops it stores
// three switchable ranking signals plus supporting fields:
//   contribution = Σ path weights            → genetic share (direct-parent heavy)
//   occurrences  = # distinct paths          → raw recurrence / multiplicity
//   convergence  = (T² − ΣBk²)/2 over sides   → Wright cross-side product (line/inbreeding)
// where each hop divides weight by the child's parent-count and Bk is the weight
// entering from each distinct parent-side (branch).

import { createPool } from './lib/db.mjs';

const MAX_DEPTH = 8; // pedigrees are shallow; 8 covers real lineages, bounds the walk
const pool = createPool();

console.log('Rebuilding strain_ancestry closure…');
await pool.query('TRUNCATE strain_ancestry');

const { rowCount } = await pool.query(`
  INSERT INTO strain_ancestry
    (descendant_id, ancestor_id, contribution, occurrences, sides, convergence, min_depth)
  WITH RECURSIVE walk AS (
    -- branch = which SIDE of the first cross (by position), not the parent's
    -- identity — so a self-cross (X x X) counts as two sides, not one.
    SELECT sp.child_strain_id AS root, sp.parent_strain_id AS anc, 1 AS depth,
           sp.position AS branch,
           ARRAY[sp.child_strain_id, sp.parent_strain_id] AS path, 1.0 / pc.n AS w
    FROM strain_parent sp
    JOIN LATERAL (SELECT COUNT(*)::numeric n FROM strain_parent x
                  WHERE x.child_strain_id = sp.child_strain_id) pc ON true
    UNION ALL
    SELECT w.root, sp.parent_strain_id, w.depth + 1, w.branch,
           w.path || sp.parent_strain_id, w.w / pc.n
    FROM strain_parent sp
    JOIN walk w ON sp.child_strain_id = w.anc
    JOIN LATERAL (SELECT COUNT(*)::numeric n FROM strain_parent x
                  WHERE x.child_strain_id = sp.child_strain_id) pc ON true
    WHERE NOT sp.parent_strain_id = ANY(w.path) AND w.depth < ${MAX_DEPTH}
  ),
  per_branch AS (
    SELECT root, anc, branch, SUM(w) AS b, COUNT(*) AS c, MIN(depth) AS md
    FROM walk GROUP BY root, anc, branch
  ),
  per_anc AS (
    SELECT root, anc,
           SUM(b) AS contribution,
           SUM(c)::int AS occurrences,
           COUNT(*)::int AS sides,
           GREATEST((power(SUM(b), 2) - SUM(power(b, 2))) / 2, 0) AS convergence,
           MIN(md)::int AS min_depth
    FROM per_branch GROUP BY root, anc
  )
  SELECT root, anc, round(contribution, 6), occurrences, sides, round(convergence, 6), min_depth
  FROM per_anc
`);

console.log(`Inserted ${rowCount} ancestry rows.`);

const { rows: [stats] } = await pool.query(`
  SELECT COUNT(DISTINCT descendant_id) AS strains,
         COUNT(*) FILTER (WHERE convergence > 0) AS converging_pairs,
         round(MAX(convergence), 4) AS max_convergence
  FROM strain_ancestry
`);
console.log(`Covering ${stats.strains} strains; ${stats.converging_pairs} converging pairs; max convergence ${stats.max_convergence}.`);

await pool.end();
console.log('Done.');

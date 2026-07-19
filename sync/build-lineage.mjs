// Build the strain graph from product lineage strings.
// Run: node --env-file=.env sync/build-lineage.mjs
//
// Idempotent: derives strain nodes + strain_parent edges fresh from products
// each run (products are the source of truth). The normalized name key is
// stored in strain.aliases[1] so re-runs and edge wiring can resolve it.

import { createPool } from './lib/db.mjs';
import { buildLineage, normalizeKey } from './lib/lineage.mjs';
import { SUPPLEMENTAL_LINEAGE, applyAlias } from './curation.mjs';

const pool = createPool();

const strains = new Map(); // key -> { key, name }
const edges = new Map();   // `${childKey}|${parentKey}|${pos}` -> { childKey, parentKey, position, sources:Set }

const { rows: products } = await pool.query(`SELECT id, source, name, lineage_text FROM product`);
console.log(`Parsing ${products.length} products…`);

const productToKey = new Map(); // product.id -> rootKey

// Collect nodes/edges from a parsed lineage, applying the alias overlay so
// spelling variants of the same cut collapse to one key.
function ingest(nodes, pEdges, source) {
  for (const n of nodes) {
    const key = applyAlias(n.key);
    const existing = strains.get(key);
    if (existing) {
      if (n.name.length < existing.name.length) existing.name = n.name; // shortest = cleanest
    } else {
      strains.set(key, { key, name: n.name });
    }
  }
  for (const e of pEdges) {
    const childKey = applyAlias(e.childKey);
    const parentKey = applyAlias(e.parentKey);
    if (childKey === parentKey) continue; // alias merge can collapse an edge onto itself
    const id = `${childKey}|${parentKey}|${e.position}`;
    (edges.get(id) ?? edges.set(id, { childKey, parentKey, position: e.position, sources: new Set() }).get(id)).sources.add(source);
  }
}

for (const p of products) {
  const { nodes, edges: pEdges, rootKey } = buildLineage(p.name, p.lineage_text);
  productToKey.set(p.id, applyAlias(rootKey));
  ingest(nodes, pEdges, p.source);
}

// Curation overlay: inject real lineages for retailer dead-end leaves.
let supp = 0;
for (const [name, lineageText] of Object.entries(SUPPLEMENTAL_LINEAGE)) {
  const { nodes, edges: pEdges } = buildLineage(name, lineageText);
  ingest(nodes, pEdges, 'curated');
  supp++;
}
console.log(`Derived ${strains.size} unique strains, ${edges.size} parent edges (incl. ${supp} curated lineages).`);

await pool.query('BEGIN');
try {
  await pool.query('UPDATE product SET strain_id = NULL');
  await pool.query('DELETE FROM strain_ancestry'); // rebuilt by build-ancestry.mjs after this
  await pool.query('DELETE FROM strain_name_review');
  await pool.query('DELETE FROM strain_parent');
  await pool.query('DELETE FROM strain');

  // --- strains ---
  const keyToId = new Map();
  const strainList = [...strains.values()];
  const CHUNK = 500;
  for (let i = 0; i < strainList.length; i += CHUNK) {
    const chunk = strainList.slice(i, i + CHUNK);
    const params = [];
    const vals = [];
    chunk.forEach((s, j) => {
      params.push(`($${j * 2 + 1}, ARRAY[$${j * 2 + 2}]::text[])`);
      vals.push(s.name, s.key);
    });
    const { rows } = await pool.query(
      `INSERT INTO strain (canonical_name, aliases) VALUES ${params.join(',')}
       RETURNING id, aliases[1] AS key`,
      vals
    );
    for (const r of rows) keyToId.set(r.key, r.id);
  }
  console.log(`Inserted ${keyToId.size} strains.`);

  // --- edges ---
  const edgeList = [...edges.values()].filter((e) => keyToId.has(e.childKey) && keyToId.has(e.parentKey));
  let edgeCount = 0;
  for (let i = 0; i < edgeList.length; i += CHUNK) {
    const chunk = edgeList.slice(i, i + CHUNK);
    const params = [];
    const vals = [];
    chunk.forEach((e, j) => {
      const b = j * 5;
      params.push(`($${b + 1}, $${b + 2}, 'unknown', $${b + 3}, $${b + 4}, $${b + 5})`);
      vals.push(keyToId.get(e.childKey), keyToId.get(e.parentKey), e.position, [...e.sources].join(','), 'parsed-prose');
    });
    // Dedup: same child/parent/position/source may recur across products.
    const { rowCount } = await pool.query(
      `INSERT INTO strain_parent (child_strain_id, parent_strain_id, side, position, source, confidence)
       VALUES ${params.join(',')}
       ON CONFLICT DO NOTHING`,
      vals
    );
    edgeCount += rowCount;
  }
  console.log(`Inserted ${edgeCount} edges.`);

  // --- link products to their root strain ---
  for (const [productId, key] of productToKey) {
    const strainId = keyToId.get(key);
    if (strainId) await pool.query('UPDATE product SET strain_id = $1 WHERE id = $2', [strainId, productId]);
  }
  console.log('Linked products to strains.');

  // --- near-miss review queue (trigram) ---
  const { rows: [{ n: reviewCount }] } = await pool.query(`
    WITH pairs AS (
      SELECT a.id a_id, b.id b_id, similarity(a.canonical_name, b.canonical_name) sim
      FROM strain a JOIN strain b
        ON a.id < b.id
       AND a.canonical_name % b.canonical_name
       AND a.canonical_name <> b.canonical_name
      WHERE similarity(a.canonical_name, b.canonical_name) BETWEEN 0.72 AND 0.97
    )
    INSERT INTO strain_name_review (a_strain_id, b_strain_id, similarity)
    SELECT a_id, b_id, round(sim::numeric, 3) FROM pairs
    ON CONFLICT DO NOTHING
    RETURNING (SELECT count(*) FROM pairs) AS n
  `).then((r) => ({ rows: [{ n: r.rows[0]?.n ?? 0 }] }));
  console.log(`Queued ${reviewCount} near-miss name pairs for review.`);

  await pool.query('COMMIT');
} catch (err) {
  await pool.query('ROLLBACK');
  console.error('FAILED, rolled back:', err);
  await pool.end();
  process.exit(1);
}

await pool.end();
console.log('Done.');

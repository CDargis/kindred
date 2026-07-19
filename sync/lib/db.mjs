import pg from 'pg';

const COLUMNS = [
  'source', 'source_id', 'sku', 'name', 'url', 'breeder', 'sex', 'flowering_type',
  'flowering_weeks_min', 'flowering_weeks_max', 'harvest_month_north', 'harvest_month_south',
  'climates', 'height_cm',
  'yield_indoor_gm2_min', 'yield_indoor_gm2_max', 'yield_outdoor_gplant_min', 'yield_outdoor_gplant_max',
  'lineage_text', 'indica_pct', 'sativa_pct', 'varietal',
  'thc_min_pct', 'thc_max_pct', 'cbd_min_pct', 'cbd_max_pct',
  'effects', 'medical', 'flavors', 'terpenes',
  'description', 'raw', 'content_hash',
];

export function createPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (run via: node --env-file=.env ...)');
  }
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
}

const UPSERT_SQL = `
  INSERT INTO product (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map((_, i) => '$' + (i + 1)).join(', ')})
  ON CONFLICT (source, source_id) DO UPDATE SET
    ${COLUMNS.filter((c) => !['source', 'source_id'].includes(c))
      .map((c) => `${c} = EXCLUDED.${c}`).join(',\n    ')},
    last_seen_at = now()
`;

export async function upsertProducts(pool, rows, { log = console.log } = {}) {
  let done = 0;
  const errors = [];
  for (const row of rows) {
    const values = COLUMNS.map((c) => (c === 'raw' ? JSON.stringify(row.raw) : row[c] ?? null));
    try {
      await pool.query(UPSERT_SQL, values);
    } catch (err) {
      errors.push({ sku: row.sku, source: row.source, error: String(err) });
    }
    done++;
    if (done % 200 === 0) {
      log(`[db] upserted ${done}/${rows.length}`);
    }
  }
  return errors;
}

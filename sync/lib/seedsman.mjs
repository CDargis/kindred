import {
  fetchWithRetry, sleep, stripHtml, contentHash,
  parseRange, splitList,
} from './util.mjs';

const GRAPHQL = 'https://www.seedsman.com/graphql';
const ROOT_CATEGORY_UID = 'Mjk='; // "Cannabis Seeds"
const PAGE_SIZE = 25; // attribute-heavy pages respond slowly; smaller = fewer timeouts

async function gql(query) {
  const res = await fetchWithRetry(`${GRAPHQL}?query=${encodeURIComponent(query)}`, { timeoutMs: 150_000 });
  const body = await res.json();
  if (body.errors) {
    throw new Error('GraphQL: ' + JSON.stringify(body.errors).slice(0, 300));
  }
  return body.data;
}

function pageQuery(page) {
  return `{
    products(filter:{category_uid:{eq:"${ROOT_CATEGORY_UID}"}}, pageSize:${PAGE_SIZE}, currentPage:${page}) {
      total_count
      page_info { total_pages }
      items {
        sku name url_key
        description { html }
        short_description { html }
        categories { name breadcrumbs { category_name } }
        s_attributes { attribute_code attribute_value attribute_options { value label } }
      }
    }
  }`;
}

/** Resolve select-type attribute values (option IDs) to their labels. */
function attrMap(sAttributes) {
  const map = {};
  for (const a of sAttributes ?? []) {
    let val = a.attribute_value;
    if (val != null && a.attribute_options?.length) {
      const options = Object.fromEntries(a.attribute_options.map((o) => [o.value, o.label]));
      val = String(val)
        .split(',')
        .map((v) => options[v.trim()] ?? v.trim())
        .join(', ');
    }
    if (val != null && val !== '' && val !== 'null') {
      map[a.attribute_code] = String(val);
    }
  }
  return map;
}

/** Group facet categories by their parent facet group (Effect, Climate, Therapeutic, ...). */
function facetGroups(categories) {
  const groups = {};
  for (const c of categories ?? []) {
    const group = c.breadcrumbs?.at(-1)?.category_name;
    if (group) {
      (groups[group] ??= []).push(c.name);
    }
  }
  return groups;
}

function normalize(item) {
  const attrs = attrMap(item.s_attributes);
  const facets = facetGroups(item.categories);

  // Prefer the exact THC value (seeds_thc, ~50% coverage) over the filter bucket.
  const [thcMin, thcMax] = parseRange(attrs.seeds_thc ?? attrs.seeds_thc_filter);
  const [cbdMin, cbdMax] = parseRange(attrs.seeds_cbd ?? attrs.seeds_cbd_filter);
  const [flwMin, flwMax] = parseRange(attrs.seeds_flowering_time);
  const [yiMin, yiMax] = parseRange(attrs.seeds_yield_indoor_filter);
  const [yoMin, yoMax] = parseRange(attrs.seeds_yield_filter);

  const variety = (attrs.seeds_variety ?? '').toLowerCase();
  const varietal = variety.includes('indica') ? 'indica-dominant'
    : variety.includes('sativa') ? 'sativa-dominant'
    : variety.includes('hybrid') || variety.includes('balanced') ? 'balanced'
    : null;

  const sexRaw = (attrs.seeds_feminised ?? '').toLowerCase();
  const floweringRaw = (attrs.seeds_flowering_type ?? '').toLowerCase();

  // Breeder value can arrive as an anchor tag; take its title attr, else strip tags.
  const brandRaw = attrs.brand ?? '';
  const breeder = (brandRaw.match(/title="([^"]+)"/) ?? [])[1] ?? stripHtml(brandRaw) ?? null;

  return {
    source: 'seedsman',
    source_id: item.sku,
    sku: item.sku,
    name: item.name.trim(),
    url: `https://www.seedsman.com/us-en/${item.url_key}`,
    breeder: breeder || null,
    sex: sexRaw.includes('fem') ? 'feminized' : sexRaw.includes('reg') ? 'regular' : 'unknown',
    flowering_type: floweringRaw.includes('auto') ? 'autoflower'
      : floweringRaw.includes('photo') ? 'photoperiod' : 'unknown',
    flowering_weeks_min: flwMin,
    flowering_weeks_max: flwMax,
    harvest_month_north: attrs.seeds_harvest_month ?? null,
    harvest_month_south: attrs.seeds_harvest_month_south ?? null,
    climates: splitList(attrs.seeds_climate),
    height_cm: null, // Seedsman only gives a Small/Medium/Tall bucket (seeds_plant_height)
    yield_indoor_gm2_min: yiMin,
    yield_indoor_gm2_max: yiMax,
    yield_outdoor_gplant_min: yoMin,
    yield_outdoor_gplant_max: yoMax,
    lineage_text: attrs.genetic_description ?? null,
    indica_pct: null,
    sativa_pct: null,
    varietal,
    thc_min_pct: thcMin,
    thc_max_pct: thcMax,
    cbd_min_pct: cbdMin,
    cbd_max_pct: cbdMax,
    // Attribute and category-facet variants duplicate each other with the same
    // sparse coverage — merge both, plus aroma/odour as the flavor analog.
    effects: [...new Set([
      ...splitList(attrs.seeds_effect_filter_2),
      ...(facets['Effect'] ?? []).map((s) => s.toLowerCase()),
    ])],
    medical: (facets['Therapeutic'] ?? []).map((s) => s.toLowerCase()),
    flavors: [...new Set([
      ...splitList(attrs.seeds_taste_filter),
      ...splitList(attrs.seeds_odour),
    ])],
    terpenes: splitList(attrs.seeds_terpenes_filter),
    description: stripHtml(item.description?.html) || stripHtml(item.short_description?.html),
    raw: {
      sku: item.sku, name: item.name, url_key: item.url_key,
      attrs, facets,
      description: item.description?.html,
    },
  };
}

export async function fetchAll({ limit = Infinity, log = console.log } = {}) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  let expectedTotal = null;
  let knownTotalPages = null;
  for (let page = 1; ; page++) {
    let data;
    try {
      data = await gql(pageQuery(page));
    } catch (err) {
      errors.push({ page, error: String(err) });
      log(`[seedsman] page ${page} failed after retries, skipping: ${String(err).slice(0, 120)}`);
      // skip this page's products rather than aborting the whole run
      if (knownTotalPages == null || page >= knownTotalPages) {
        break;
      }
      continue;
    }
    const { items, total_count, page_info } = data.products;
    expectedTotal = total_count;
    knownTotalPages = page_info.total_pages;
    for (const item of items) {
      if (seen.has(item.sku)) {
        continue; // relevance sort can shift between pages; dedupe by sku
      }
      seen.add(item.sku);
      try {
        const row = normalize(item);
        row.content_hash = contentHash(row.raw);
        rows.push(row);
      } catch (err) {
        errors.push({ sku: item.sku, error: String(err) });
      }
    }
    log(`[seedsman] page ${page}/${page_info.total_pages} (${rows.length}/${total_count})`);
    if (page >= page_info.total_pages || items.length === 0 || rows.length >= limit) {
      break;
    }
    await sleep(1_000);
  }
  return { rows: rows.slice(0, limit), errors, expectedTotal };
}

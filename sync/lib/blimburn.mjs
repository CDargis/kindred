import {
  fetchWithRetry, mapConcurrent, sleep, stripHtml, contentHash,
  parseRange, splitList, deriveVarietal,
} from './util.mjs';

const STORE_API = 'https://blimburnseeds.com/wp-json/wc/store/v1/products';
const PER_PAGE = 100;
const PDP_CONCURRENCY = 4;

/** Fetch every product from the Store API listing (14 pages for ~1,373 products). */
async function fetchListing({ limit = Infinity, log = console.log } = {}) {
  const products = [];
  for (let page = 1; ; page++) {
    const res = await fetchWithRetry(`${STORE_API}?per_page=${PER_PAGE}&page=${page}`);
    const batch = await res.json();
    products.push(...batch);
    const totalPages = Number(res.headers.get('x-wp-totalpages') ?? page);
    log(`[blimburn] listing page ${page}/${totalPages} (${products.length} products)`);
    if (page >= totalPages || batch.length === 0 || products.length >= limit) {
      break;
    }
    await sleep(800);
  }
  return products.slice(0, limit);
}

/** Parse the PDP spec table (bbs-cp-info-table) into a label -> value map. */
export function parsePdp(html) {
  const kv = {};
  const table = html.match(/bbs-cp-info-table[\s\S]*?<\/table>/);
  if (table) {
    for (const row of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map((m) => stripHtml(m[1]))
        .filter(Boolean);
      if (cells.length >= 2) {
        kv[cells[0]] = cells.slice(1).join(' ');
      }
    }
  }
  // Fallback: the 3-group icon block (Flavors / Effects / Medical) if the table lacked them.
  for (const block of html.split('bbs-cp-attribute-block__header').slice(1)) {
    const title = (block.match(/bbs-cp-attribute-block__title[^>]*>([^<]+)/) ?? [])[1]?.trim();
    if (title && !kv[title]) {
      const labels = [...block.matchAll(/bbs-cp-attribute-block__icon-label[^>]*>([^<]+)/g)]
        .map((m) => m[1].trim());
      if (labels.length) {
        kv[title] = labels.join(', ');
      }
    }
  }
  return kv;
}

function normalize(p, specs) {
  const [thcMin, thcMax] = parseRange(specs['THC']);
  const [cbdMin, cbdMax] = parseRange(specs['CBD']);
  const [flwMin, flwMax] = parseRange(specs['Flowering Time']);

  // "1.97 - 2.13 oz/ft² | 600 - 650 g/m²" -> parse only the metric segment
  const metricSegment = (text, unitRe) => {
    if (!text) {
      return [null, null];
    }
    const seg = text.split('|').find((s) => unitRe.test(s));
    return seg ? parseRange(seg) : [null, null];
  };
  const [yiMin, yiMax] = metricSegment(specs['Yield Indoor'], /g\/m/i);
  const [yoMin, yoMax] = metricSegment(specs['Yield Outdoor'], /g\/plant/i);

  const heightM = specs['Height']?.match(/(\d+(?:\.\d+)?)\s*m\b/i);
  const indica = specs['Phenotype']?.match(/(\d+(?:\.\d+)?)\s*%\s*Indica/i);
  const sativa = specs['Phenotype']?.match(/(\d+(?:\.\d+)?)\s*%\s*Sativa/i);
  const indicaPct = indica ? Number(indica[1]) : null;
  const sativaPct = sativa ? Number(sativa[1]) : null;

  const type = (specs['Type'] ?? '').toLowerCase();
  const nameLc = p.name.toLowerCase();
  const isAuto = type.includes('auto') || /\bauto\b/.test(nameLc);

  return {
    source: 'blimburn',
    source_id: String(p.id),
    sku: p.sku ?? '',
    name: p.name,
    url: p.permalink,
    breeder: 'Blimburn',
    sex: type.includes('fem') ? 'feminized' : type.includes('regular') ? 'regular' : isAuto ? 'feminized' : 'unknown',
    flowering_type: isAuto ? 'autoflower' : 'photoperiod',
    flowering_weeks_min: flwMin,
    flowering_weeks_max: flwMax,
    harvest_month_north: specs['Harvest Month'] ?? null,
    harvest_month_south: null,
    climates: splitList(specs['Climate']),
    height_cm: heightM ? Math.round(Number(heightM[1]) * 100) : null,
    yield_indoor_gm2_min: yiMin,
    yield_indoor_gm2_max: yiMax,
    yield_outdoor_gplant_min: yoMin,
    yield_outdoor_gplant_max: yoMax,
    lineage_text: specs['Lineage'] ?? null,
    indica_pct: indicaPct,
    sativa_pct: sativaPct,
    varietal: deriveVarietal(indicaPct, sativaPct),
    thc_min_pct: thcMin,
    thc_max_pct: thcMax,
    cbd_min_pct: cbdMin,
    cbd_max_pct: cbdMax,
    effects: splitList(specs['Effects']),
    medical: splitList(specs['Medical']),
    flavors: splitList(specs['Flavors']),
    terpenes: splitList(specs['Terpenes']),
    description: stripHtml(p.description),
    raw: {
      store: {
        id: p.id, name: p.name, sku: p.sku, permalink: p.permalink,
        description: p.description, short_description: p.short_description,
        categories: p.categories, tags: p.tags, attributes: p.attributes,
      },
      pdpSpecs: specs,
    },
  };
}

export async function fetchAll({ limit = Infinity, log = console.log } = {}) {
  const listing = await fetchListing({ limit, log });
  const errors = [];
  const warnings = [];
  let done = 0;

  const rows = await mapConcurrent(listing, PDP_CONCURRENCY, async (p) => {
    let specs = {};
    try {
      await sleep(200 + Math.random() * 300); // stagger, stay polite
      const res = await fetchWithRetry(p.permalink);
      specs = parsePdp(await res.text());
      if (Object.keys(specs).length === 0) {
        // promo/bundle pages legitimately have no spec table — keep the row, note it
        warnings.push({ sku: p.sku, url: p.permalink, warning: 'no spec table found' });
      }
    } catch (err) {
      errors.push({ sku: p.sku, url: p.permalink, error: String(err) });
    }
    done++;
    if (done % 50 === 0) {
      log(`[blimburn] PDPs ${done}/${listing.length}`);
    }
    const row = normalize(p, specs);
    row.content_hash = contentHash(row.raw);
    return row;
  });

  return { rows, errors, warnings };
}

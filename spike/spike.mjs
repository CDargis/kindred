// Minimal feasibility spike: can we pull structured strain data from
// Blimburn and Seedsman without a browser? Run: node spike/spike.mjs
//
// Findings this proves:
//  - Blimburn (WooCommerce): public Store API, full catalog = 1,373 products
//    at 100/page (~14 requests). Lineage/THC/effects live in description HTML
//    under consistent headings.
//  - Seedsman (Magento): public GraphQL, full catalog = ~2,265 products under
//    category uid "Mjk=" at 100/page (~23 requests). Effects/climate/genetics
//    are structured category memberships per product.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SAMPLE = 5; // products per source for the spike
const DELAY_MS = 1500; // be polite

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (html) =>
  (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// --- Blimburn -------------------------------------------------------------

// Description HTML uses <h2>/<h3> section headings (Lineage, Origin, ...).
// Pull the text that follows a heading containing the given word.
function sectionAfterHeading(html, word) {
  const re = new RegExp(
    `<h[23][^>]*>[^<]*${word}[^<]*</h[23]>\\s*([\\s\\S]*?)(?=<h[23]|$)`,
    "i"
  );
  const m = html.match(re);
  return m ? stripHtml(m[1]).slice(0, 300) : null;
}

function extractFromText(text, re) {
  const m = text.match(re);
  return m ? m[0] : null;
}

async function spikeBlimburn() {
  const url = `https://blimburnseeds.com/wp-json/wc/store/v1/products?per_page=${SAMPLE}&page=1`;
  const products = await getJson(url);
  return products.map((p) => {
    const text = stripHtml(p.description);
    return {
      source: "blimburn",
      name: p.name,
      sku: p.sku,
      url: p.permalink,
      categories: p.categories.map((c) => c.name),
      lineage: sectionAfterHeading(p.description, "Lineage"),
      thc: extractFromText(text, /\d{1,2}(?:\.\d)?%?\s*(?:–|-|to)\s*\d{1,2}(?:\.\d)?%(?=[^%]*THC)|THC[^.]{0,40}?\d{1,2}(?:\.\d)?%(?:\s*(?:–|-|to)\s*\d{1,2}(?:\.\d)?%)?/i),
      indicaSativa: extractFromText(text, /\d{1,3}%\s*(?:Indica|Sativa)[^.]{0,30}/i),
      descriptionExcerpt: text.slice(0, 200),
    };
  });
}

// --- Seedsman ---------------------------------------------------------------

async function seedsmanGraphql(query) {
  const url =
    "https://www.seedsman.com/graphql?query=" + encodeURIComponent(query);
  const body = await getJson(url);
  if (body.errors) {
    throw new Error("GraphQL errors: " + JSON.stringify(body.errors));
  }
  return body.data;
}

async function spikeSeedsman() {
  const query = `{
    products(filter:{category_uid:{eq:"Mjk="}}, pageSize:${SAMPLE}, currentPage:1) {
      total_count
      items {
        name sku url_key
        categories { name breadcrumbs { category_name } }
        description { html }
      }
    }
  }`;
  const data = await seedsmanGraphql(query);
  return data.products.items.map((p) => ({
    source: "seedsman",
    name: p.name.trim(),
    sku: p.sku,
    url: `https://www.seedsman.com/us-en/${p.url_key}`,
    // Facets (Effect, Climate, Genetics, Sex, ...) arrive as category
    // memberships; breadcrumbs tell us which facet group each belongs to.
    facets: p.categories.map((c) => {
      const group = c.breadcrumbs?.at(-1)?.category_name;
      return group ? `${group}: ${c.name}` : c.name;
    }),
    descriptionExcerpt: stripHtml(p.description?.html).slice(0, 200),
  }));
}

// --- Run --------------------------------------------------------------------

const blimburn = await spikeBlimburn();
await sleep(DELAY_MS);
const seedsman = await spikeSeedsman();

const results = { fetchedAt: new Date().toISOString(), blimburn, seedsman };
const outPath = new URL("./spike-output.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(outPath, JSON.stringify(results, null, 2));

console.log(JSON.stringify(results, null, 2));
console.log(`\nWrote ${blimburn.length + seedsman.length} products to spike/spike-output.json`);

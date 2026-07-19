// Curated genetics overlay — hand-maintained corrections that persist across
// graph rebuilds (products stay the source of truth; this augments them).
//
// Three kinds of correction:
//  1. SUPPLEMENTAL_LINEAGE — real lineages for strains the retailers list as
//     dead-end leaves (no product sells them, so the graph never learned their
//     parents). Parsed exactly like a product lineage string.
//  2. ALIAS_MERGE — collapse spelling variants of the SAME cut to one key.
//     ONLY true synonyms/misspellings. Distinct cuts (Chemdog #4 vs Chemdog 91)
//     are consolidated to a canonical *cut* key but kept separate from the base.
//  3. FAMILIES — group distinct cuts under an umbrella for "how much of this
//     LINE" queries, WITHOUT flattening the cuts into one node.

// key (normalized) -> lineage text (same grammar as product lineage_text)
export const SUPPLEMENTAL_LINEAGE = {
  // Tres Dawg (Top Dawg) = Chem D x (Afghani x Chem D) — a Chemdog backcross,
  // ~75% Chemdog. Was a leaf; this unlocks Stardawg's true Chemdog depth.
  'tres dawg': 'Chem D x (Afghani x Chem D)',
  // Headband = OG Kush x Sour Diesel (both Chemdog-derived).
  'headband': 'OG Kush x Sour Diesel',
  // East Coast Sour Diesel is the original Sour Diesel cut — a selection of it.
  'east coast sour diesel': 'Sour Diesel',
};

// variant key -> canonical key. Base Chemdog synonyms collapse to 'chemdog';
// each distinct numbered cut collapses to one canonical cut key but stays
// separate from the base and from each other.
export const ALIAS_MERGE = {
  // base Chemdog = Chemdawg (interchangeable spellings) + typos
  'chemdawg': 'chemdog', 'chem dawg': 'chemdog', 'chem dog': 'chemdog',
  'chemdowg': 'chemdog', 'chemdwag': 'chemdog',
  // the #4 cut (a.k.a. Chemdawg 4 / Chem 4) — distinct pheno, kept separate
  'chemdog #4': 'chemdog 4', 'chemdawg 4': 'chemdog 4', 'chemdawg #4': 'chemdog 4',
  'chem 4': 'chemdog 4', 'chemdog4': 'chemdog 4', 'chem #4': 'chemdog 4',
  // the '91 cut
  'chem 91': 'chemdog 91', 'chemdog #91': 'chemdog 91', 'chem 91': 'chemdog 91',
  'chemdog91': 'chemdog 91', 'chem dog 91': 'chemdog 91',
};

// umbrella -> member cut keys (post-alias). For "how much of this LINE" queries.
export const FAMILIES = {
  'chemdog family': ['chemdog', 'chemdog 4', 'chemdog 91', 'chem d'],
};

export const applyAlias = (key) => ALIAS_MERGE[key] ?? key;

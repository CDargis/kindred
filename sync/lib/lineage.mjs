// Parse retailer lineage strings into a strain ancestry tree.
//
// Grammar handled (informally):
//   cross       := part (' x ' part)+          e.g. "OG Kush x GDP x Ruderalis"
//   named-expr  := Name '(' expr ')'           e.g. "Do-Si-Dos (OGKB x FaceOff OG)"
//   grouping    := '(' expr ')' | '[' expr ']'
//   leaf        := a strain name
// Prose entries (landrace descriptions, "F3 semi-stabilized hybrid", etc.) have
// no parseable cross and yield a single leaf with no parents.

// Retail packaging cruft stripped from a name for its canonical key. Keeps
// "auto" (autoflowers genuinely differ genetically) and #N / BxN / FN / vN
// (distinct cuts), but drops the seed-shop suffixes and pack-size markers that
// otherwise fragment the same strain into many nodes.
const RETAIL_SUFFIX = /\b(feminized|feminised|regular|autoflowering)\s+seeds?\b|\bcannabis\s+seeds?\b|\bseeds?\b/gi;
const PACK_MARKER = /\s*[-–]\s*\d+\s*$|\(\s*\d+\s*seeds?\s*\)|\bx\s*\d+\b/gi;
const STANDALONE = /\b(fem|reg|feminized|feminised|reversed|elite|clone[- ]?only|ibl)\b/gi;

// Non-strain placeholders: never become graph nodes. Real short names
// (og, ak, nl, gg, gg4, c4, z) are deliberately NOT here.
const BLOCKLIST = new Set([
  '', 'hybrid', 'indica', 'sativa', 'ruderalis auto', 'secret', 'secret hybrid',
  'unknown', 'unknown strain', 'mix', 'mystery', 'cbd', 'auto', 'autoflower',
  'automatic', 'fast', 'fast version', 'fast bud', 'fast buds',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'g1', 's1', 's2', '1', '2', '3', '#1', '#2',
  'undisclosed', 'various', 'na', 'n a',
]);

// Words that mark an entry as prose rather than a strain name.
const PROSE_WORDS = /\b(generation|province|region|from the|stabili[sz]ed|selected|crossed with our|parental|between|northwestern|southeastern|border|our best|semi)\b/i;

export function normalizeKey(raw) {
  const key = raw
    .replace(/\b(a\.?k\.?a\.?)\b.*$/i, '') // drop "aka ..." trailers
    .replace(PACK_MARKER, ' ')
    .replace(RETAIL_SUFFIX, ' ')
    .replace(STANDALONE, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return BLOCKLIST.has(key) ? '' : key;
}

export function displayName(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Split on top-level ' x ' / ' X ' / ' × ' / 'crossed with', ignoring bracketed depth. */
function splitTopLevelCross(text) {
  const parts = [];
  let depth = 0;
  let buf = '';
  const tokens = text.split(/(\s+x\s+|\s+X\s+|\s*×\s*|\s+crossed with\s+)/i);
  for (const tok of tokens) {
    if (/^\s*(x|X|×|crossed with)\s*$/i.test(tok)) {
      // separator — only splits when we're at bracket depth 0
      if (depth === 0) {
        parts.push(buf);
        buf = '';
        continue;
      }
    }
    for (const ch of tok) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
    buf += tok;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripOuterBracket(text) {
  const t = text.trim();
  const pairs = { '(': ')', '[': ']' };
  const open = t[0];
  if (!pairs[open] || t.at(-1) !== pairs[open]) return null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(' || t[i] === '[') depth++;
    else if (t[i] === ')' || t[i] === ']') {
      depth--;
      if (depth === 0 && i !== t.length - 1) return null; // bracket closes early → not a pure wrapper
    }
  }
  return t.slice(1, -1).trim();
}

/** Split "Name (expansion)" → { name, expansion } when a name precedes a trailing bracket group. */
function splitNamedExpansion(text) {
  const t = text.trim();
  const m = t.match(/^(.+?)\s*([([].*[)\]])$/s);
  if (!m) return null;
  const name = m[1].trim();
  const inner = stripOuterBracket(m[2]);
  if (!name || inner == null) return null;
  return { name, expansion: inner };
}

/**
 * Parse text into a node: { name, key, children: [nodes] }.
 * children are the parents (crossed lines). Prose leaves get no children.
 * Returns null if text is empty.
 */
export function parseNode(text, depth = 0) {
  const t = text.trim();
  if (!t || depth > 12) return null;

  // Pure grouping wrapper: "(A x B)" → parse inside.
  const unwrapped = stripOuterBracket(t);
  if (unwrapped != null) return parseNode(unwrapped, depth + 1);

  // Top-level cross → anonymous cross node whose children are the parts.
  const parts = splitTopLevelCross(t);
  if (parts.length > 1) {
    const children = parts.map((p) => parseNode(p, depth + 1)).filter(Boolean);
    const name = children.map((c) => c.name).join(' x ');
    // Canonical key sorts parent keys so reciprocal crosses (A x B / B x A) merge.
    const key = children.map((c) => c.key).filter(Boolean).sort().join(' x ');
    return { name: displayName(name), key, children, anon: true };
  }

  // "Name (expansion)" → named strain with its own parents from the expansion.
  const named = splitNamedExpansion(t);
  if (named) {
    const child = parseNode(named.expansion, depth + 1);
    return {
      name: displayName(named.name),
      key: normalizeKey(named.name),
      children: child ? (child.anon ? child.children : [child]) : [],
    };
  }

  // Leaf. If it reads like prose, keep as a childless node but flag it.
  const isProse = PROSE_WORDS.test(t) || t.split(/\s+/).length > 7;
  return { name: displayName(t), key: normalizeKey(t), children: [], prose: isProse };
}

/**
 * Given a product's own name and its lineage string, return:
 *   { root, edges } where edges = [{ childKey, parentKey, position }]
 * The product name is the root; the lineage's top-level parts are its parents.
 */
export function buildLineage(productName, lineageText) {
  const nodes = new Map(); // key -> node (deduped)
  const edges = [];

  function collect(node) {
    // Skip blocklisted/empty keys (normalizeKey → '') and prose sentences.
    if (!node || !node.key || node.prose) return null;
    if (!nodes.has(node.key)) nodes.set(node.key, { key: node.key, name: node.name });
    node.children.forEach((c, i) => {
      const childNode = collect(c);
      if (childNode && childNode.key !== node.key) {
        edges.push({ childKey: node.key, parentKey: childNode.key, position: i });
      }
    });
    return nodes.get(node.key);
  }

  // Parse the product name itself — if it's a cross ("A × B"), its sorted key
  // canonicalizes reciprocal crosses. Otherwise the name is a leaf.
  const nameNode = parseNode(productName);
  // A product is always a real strain, so never let it fall to a blocklisted
  // empty key — fall back to a raw slug of its name.
  const rootKey = (nameNode?.anon ? nameNode.key : normalizeKey(productName))
    || productName.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim()
    || 'unnamed';
  const rootName = displayName(productName);
  nodes.set(rootKey, { key: rootKey, name: rootName });

  // Parents come from the lineage string when present; else from the name's
  // own cross structure (e.g. a product simply named "A x B" with no lineage).
  const parsed = (lineageText ? parseNode(lineageText) : null)
    ?? (nameNode?.anon ? nameNode : null);
  if (parsed) {
    const parents = parsed.anon ? parsed.children : [parsed];
    parents.forEach((p, i) => {
      const pNode = collect(p);
      if (pNode && pNode.key !== rootKey) {
        edges.push({ childKey: rootKey, parentKey: pNode.key, position: i });
      }
    });
  }

  return { nodes: [...nodes.values()], edges, rootKey };
}

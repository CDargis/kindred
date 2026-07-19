import { createHash } from 'node:crypto';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const stripHtml = (html) =>
  (html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function contentHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export async function fetchWithRetry(url, opts = {}, tries = 4) {
  const { timeoutMs = 45_000, ...fetchOpts } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        ...fetchOpts,
        headers: { 'User-Agent': UA, ...(fetchOpts.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Retry on rate limiting or server errors; 4xx other than 429 is permanent.
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        await sleep(2_000 * attempt);
      }
    }
  }
  throw lastErr;
}

/** Run fn over items with bounded concurrency; returns results in order. */
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers.map((w) => w));
  return results;
}

/**
 * Parse a numeric range out of free text.
 * "26% - 32% (High)" -> [26, 32]; "8 to 10 weeks" -> [8, 10];
 * "25%+" / "above 750" -> [25, null]; "below 15%" -> [null, 15];
 * "22%" -> [22, 22]; no number -> [null, null].
 */
export function parseRange(text) {
  if (!text) {
    return [null, null];
  }
  const t = String(text).replace(/[–—]/g, '-').replace(/,(\d{3})/g, '$1');
  const range = t.match(/(\d+(?:\.\d+)?)\s*%?\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
  if (range) {
    return [Number(range[1]), Number(range[2])];
  }
  const above = t.match(/(?:above|over|\+|more than)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*%?\s*\+/i);
  if (above) {
    return [Number(above[1] ?? above[2]), null];
  }
  const below = t.match(/(?:below|under|less than)\s*(\d+(?:\.\d+)?)/i);
  if (below) {
    return [null, Number(below[1])];
  }
  const single = t.match(/(\d+(?:\.\d+)?)/);
  if (single) {
    return [Number(single[1]), Number(single[1])];
  }
  return [null, null];
}

/** "Stress, Depression, Pain" -> ['stress', 'depression', 'pain'] */
export function splitList(text) {
  if (!text) {
    return [];
  }
  return [...new Set(
    String(text)
      .split(/[,;/]| and /i)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== 'null' && s !== 'n/a')
  )];
}

export function deriveVarietal(indicaPct, sativaPct) {
  if (indicaPct == null || sativaPct == null) {
    return null;
  }
  if (indicaPct > 60) {
    return 'indica-dominant';
  }
  if (sativaPct > 60) {
    return 'sativa-dominant';
  }
  return 'balanced';
}

import { buildReport, type ComplianceReport } from './lib/reporter.js';
import { checkDiscovery } from './checks/discovery.js';
import { checkCatalog } from './checks/catalog.js';
import { checkCheckout } from './checks/checkout.js';
import { checkGeneral } from './checks/general.js';

/** Normalise a base URL: strip trailing slash, ensure protocol. */
export function normaliseUrl(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/** Resolve a potentially-relative path against a base URL. */
export function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const b = normaliseUrl(base);
  const p = path.startsWith('/') ? path : '/' + path;
  return b + p;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  data: unknown;
  contentType: string;
}

/** Fetch a URL and attempt JSON parse. Never throws. */
export async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { Accept: 'application/json, */*' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown = null;
    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      try {
        data = await response.json();
      } catch {
        // malformed JSON
      }
    } else {
      // Still try to parse — some servers return JSON with wrong content-type
      try {
        const text = await response.text();
        data = JSON.parse(text);
      } catch {
        // genuinely not JSON
      }
    }

    return { ok: response.ok, status: response.status, data, contentType };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: isAbort ? 408 : 0,
      data: null,
      contentType: '',
    };
  }
}

export async function runChecks(url: string): Promise<ComplianceReport> {
  const base = normaliseUrl(url);
  const allResults = [];

  // General checks (HTTPS etc.)
  allResults.push(...checkGeneral(base));

  // Discovery
  const { results: discoveryResults, parsed } = await checkDiscovery(base);
  allResults.push(...discoveryResults);

  if (parsed) {
    // Catalog
    const catalogResults = await checkCatalog(base, parsed);
    allResults.push(...catalogResults);

    // Checkout
    const checkoutResults = await checkCheckout(base, parsed);
    allResults.push(...checkoutResults);
  }

  return buildReport(url, allResults);
}

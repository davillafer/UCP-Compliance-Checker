import type { CheckResult } from '../lib/reporter.js';
import { fetchJson, resolveUrl } from '../checker.js';
import type { ParsedDiscovery } from './discovery.js';

/**
 * Catalog checks.
 *
 * Official spec endpoints:
 *   POST /catalog/search  — free-text product search
 *   POST /catalog/lookup  — batch lookup by product/variant ID
 *
 * Legacy (Pudding Heroes):
 *   GET /api/ucp/products       — list all
 *   GET /api/ucp/products/:id   — single lookup
 *
 * Required product fields per spec: id, title, description, price_range, variants
 * Legacy required fields: id, name, price, currency
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Check spec-required product fields: id, title, description, price_range, variants */
function checkSpecProductFields(product: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!product['id']) missing.push('id');
  if (!product['title']) missing.push('title');
  if (!product['description']) missing.push('description');
  if (!product['price_range'] && !product['priceRange']) missing.push('price_range');
  if (!Array.isArray(product['variants'])) missing.push('variants');
  return missing;
}

/** Check legacy product fields: id, name/title, price, currency */
function checkLegacyProductFields(product: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!product['id']) missing.push('id');
  if (!product['name'] && !product['title']) missing.push('name/title');

  const hasDirectPrice = 'price' in product;
  const hasVariantPrice =
    Array.isArray(product['variants']) &&
    (product['variants'] as Array<Record<string, unknown>>).some(
      (v) => isRecord(v['price']) && 'amount' in v['price']
    );
  if (!hasDirectPrice && !hasVariantPrice) missing.push('price');
  if (!product['currency']) missing.push('currency');
  return missing;
}

/** Extract products array from various response shapes */
function extractProducts(data: unknown): unknown[] | null {
  if (!isRecord(data)) return Array.isArray(data) ? data : null;
  if (Array.isArray(data['products'])) return data['products'];
  if (isRecord(data['data']) && Array.isArray((data['data'] as Record<string, unknown>)['products'])) {
    return (data['data'] as Record<string, unknown>)['products'] as unknown[];
  }
  return null;
}

export interface CatalogProducts {
  products: Array<Record<string, unknown>>;
  isSpec: boolean;
}

/** Try spec catalog endpoints, then legacy. Returns products + which mode. */
async function fetchCatalogProducts(
  baseUrl: string,
  parsed: ParsedDiscovery,
  results: CheckResult[]
): Promise<CatalogProducts | null> {
  const cat = 'Catalog';

  // --- Try spec endpoints first: POST /catalog/search ---
  const specBase = parsed.shoppingEndpoint;
  if (specBase) {
    const searchUrl = specBase + '/catalog/search';
    const searchResp = await postJson(searchUrl, { query: '', pagination: { first: 5 } });

    if (searchResp.ok && searchResp.data) {
      results.push({ category: cat, check: 'POST /catalog/search returns 200', status: 'pass' });

      const products = extractProducts(searchResp.data);
      if (products && products.length > 0) {
        results.push({
          category: cat,
          check: 'search response contains products array',
          status: 'pass',
          detail: `${products.length} product(s)`,
        });
        return { products: products.filter(isRecord) as Array<Record<string, unknown>>, isSpec: true };
      } else {
        results.push({ category: cat, check: 'search response contains products array', status: 'fail' });
      }
    } else if (searchResp.status !== 0) {
      results.push({
        category: cat,
        check: 'POST /catalog/search returns 200',
        status: 'fail',
        detail: `${searchUrl} returned ${searchResp.status}`,
      });
    }
  }

  // --- Try legacy GET /products ---
  const legacyProductsUrl =
    parsed.legacyServices['products'] ??
    (specBase ? specBase + '/products' : null);

  if (legacyProductsUrl) {
    const legacyResp = await fetchJson(legacyProductsUrl);
    if (legacyResp.ok && legacyResp.data) {
      if (specBase) {
        results.push({
          category: cat,
          check: 'catalog available via GET (non-spec)',
          status: 'warn',
          detail: `${legacyProductsUrl} — spec uses POST /catalog/search`,
        });
      } else {
        results.push({ category: cat, check: 'products endpoint returns 200', status: 'pass' });
      }

      const products = extractProducts(legacyResp.data);
      if (products && products.length > 0) {
        results.push({
          category: cat,
          check: 'response contains products array',
          status: 'pass',
          detail: `${products.length} product(s)`,
        });
        return { products: products.filter(isRecord) as Array<Record<string, unknown>>, isSpec: false };
      }
    }
  }

  // --- Fallback: try common path ---
  const fallbackUrl = resolveUrl(baseUrl, '/api/ucp/products');
  if (fallbackUrl !== legacyProductsUrl) {
    const fallbackResp = await fetchJson(fallbackUrl);
    if (fallbackResp.ok && fallbackResp.data) {
      results.push({
        category: cat,
        check: 'catalog available via non-standard path',
        status: 'warn',
        detail: `${fallbackUrl} — spec uses POST /catalog/search at shopping endpoint`,
      });
      const products = extractProducts(fallbackResp.data);
      if (products && products.length > 0) {
        return { products: products.filter(isRecord) as Array<Record<string, unknown>>, isSpec: false };
      }
    }
  }

  results.push({ category: cat, check: 'catalog endpoint reachable', status: 'fail' });
  return null;
}

/** POST JSON helper, same shape as fetchJson. */
async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown; contentType: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    return { ok: response.ok, status: response.status, data, contentType };
  } catch {
    return { ok: false, status: 0, data: null, contentType: '' };
  }
}

export async function checkCatalog(
  baseUrl: string,
  parsed: ParsedDiscovery
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cat = 'Catalog';

  // Only run if catalog or shopping capability is declared
  const hasCatalogCap = parsed.capabilities.some(
    (c) => c.includes('catalog') || c === 'dev.ucp.shopping'
  );
  if (!hasCatalogCap && parsed.format === 'spec') {
    return results;
  }
  // For legacy, run if any products service is declared
  if (!hasCatalogCap && !parsed.legacyServices['products']) {
    return results;
  }

  const catalog = await fetchCatalogProducts(baseUrl, parsed, results);
  if (!catalog) return results;

  const { products, isSpec } = catalog;

  // --- Required fields ---
  const checkFields = isSpec ? checkSpecProductFields : checkLegacyProductFields;
  const fieldLabel = isSpec
    ? 'products have required fields (id, title, description, price_range, variants)'
    : 'products have required fields (id, name, price, currency)';

  const allMissing: string[] = [];
  for (const p of products.slice(0, 5)) {
    allMissing.push(...checkFields(p));
  }
  const uniqueMissing = [...new Set(allMissing)];

  if (uniqueMissing.length === 0) {
    results.push({ category: cat, check: fieldLabel, status: 'pass' });
  } else {
    results.push({
      category: cat,
      check: fieldLabel,
      status: 'fail',
      detail: `Missing: ${uniqueMissing.join(', ')}`,
    });
  }

  // --- Spec: POST /catalog/lookup ---
  const firstId = products[0]?.['id'] as string | undefined;
  if (!firstId) {
    results.push({ category: cat, check: 'product lookup by ID', status: 'warn', detail: 'No product ID to test' });
    return results;
  }

  if (isSpec && parsed.shoppingEndpoint) {
    const lookupUrl = parsed.shoppingEndpoint + '/catalog/lookup';
    const lookupResp = await postJson(lookupUrl, { ids: [firstId] });
    if (lookupResp.ok && lookupResp.data) {
      const lookupProducts = extractProducts(lookupResp.data);
      if (lookupProducts && lookupProducts.length > 0) {
        results.push({ category: cat, check: 'POST /catalog/lookup returns product by ID', status: 'pass' });
      } else {
        results.push({ category: cat, check: 'POST /catalog/lookup returns product by ID', status: 'fail', detail: 'Empty result' });
      }
    } else {
      results.push({
        category: cat,
        check: 'POST /catalog/lookup returns product by ID',
        status: 'fail',
        detail: `${lookupUrl} returned ${lookupResp.status}`,
      });
    }
  } else {
    // Legacy: GET /products/:id
    const legacyProductsUrl = parsed.legacyServices['products'] ?? resolveUrl(baseUrl, '/api/ucp/products');
    const singleUrl = `${legacyProductsUrl}/${encodeURIComponent(firstId)}`;
    const singleResp = await fetchJson(singleUrl);
    if (singleResp.ok && singleResp.data) {
      results.push({ category: cat, check: 'single product lookup by ID (GET)', status: 'pass' });
    } else {
      results.push({
        category: cat,
        check: 'single product lookup by ID (GET)',
        status: 'fail',
        detail: `${singleUrl} returned ${singleResp.status}`,
      });
    }
  }

  return results;
}

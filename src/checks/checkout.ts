import type { CheckResult } from '../lib/reporter.js';
import { resolveUrl } from '../checker.js';
import type { ParsedDiscovery } from './discovery.js';

/**
 * Checkout checks per UCP spec 2026-01-23.
 *
 * Endpoints:
 *   POST   /checkout-sessions             — create
 *   GET    /checkout-sessions/:id         — read
 *   PUT    /checkout-sessions/:id         — update
 *   POST   /checkout-sessions/:id/complete — complete (payment required here, not on create)
 *   POST   /checkout-sessions/:id/cancel   — cancel
 *
 * Required headers: Request-Id, UCP-Agent (profile="<uri>"), Idempotency-Key
 *
 * 2026-01-23 changes vs 2026-01-11:
 *   - payment is NOT required on create (only on complete)
 *   - currency is output-only (derived by merchant from context/geo)
 *   - new context field on create: { address_country, address_region, postal_code }
 *   - complete submits full checkout object, not payment_data
 */

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Get a product/variant ID to use in the test checkout. */
async function getTestItemId(parsed: ParsedDiscovery, baseUrl: string): Promise<{ id: string; isVariant: boolean } | null> {
  if (parsed.shoppingEndpoint) {
    try {
      const searchUrl = parsed.shoppingEndpoint + '/catalog/search';
      const resp = await fetch(searchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: '', pagination: { first: 1 } }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        const products = Array.isArray(data['products']) ? data['products'] : [];
        const first = isRecord(products[0]) ? products[0] : null;
        if (first) {
          const variants = Array.isArray(first['variants']) ? first['variants'] : [];
          const firstVariant = isRecord(variants[0]) ? variants[0] : null;
          if (firstVariant && typeof firstVariant['id'] === 'string') {
            return { id: firstVariant['id'], isVariant: true };
          }
          if (typeof first['id'] === 'string') return { id: first['id'], isVariant: false };
        }
      }
    } catch { /* continue to legacy */ }
  }

  const productsUrl = parsed.legacyServices['products'] ?? resolveUrl(baseUrl, '/api/ucp/products');
  try {
    const resp = await fetch(productsUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      const products = Array.isArray(data['products']) ? data['products'] : [];
      const first = isRecord(products[0]) ? products[0] : null;
      if (first && typeof first['id'] === 'string') {
        return { id: first['id'], isVariant: false };
      }
    }
  } catch { /* give up */ }

  return null;
}

export async function checkCheckout(
  baseUrl: string,
  parsed: ParsedDiscovery
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cat = 'Checkout';

  if (!parsed.capabilities.includes('dev.ucp.shopping.checkout')) {
    return results;
  }

  // --- Resolve checkout URL ---
  let checkoutUrl: string | null = null;

  if (parsed.shoppingEndpoint) {
    checkoutUrl = parsed.shoppingEndpoint + '/checkout-sessions';
  } else if (parsed.legacyServices['checkout']) {
    checkoutUrl = parsed.legacyServices['checkout'];
  }

  if (!checkoutUrl) {
    results.push({ category: cat, check: 'checkout endpoint resolvable', status: 'fail' });
    return results;
  }
  results.push({ category: cat, check: 'checkout endpoint resolvable', status: 'pass', detail: checkoutUrl });

  // --- Get a test item ---
  const testItem = await getTestItemId(parsed, baseUrl);

  // --- Build request (2026-01-23: no payment on create, context is optional) ---
  const isSpec = parsed.format === 'spec';

  let body: unknown;
  if (isSpec && testItem) {
    body = {
      line_items: [{ item: { id: testItem.id }, quantity: 1 }],
      // 2026-01-23: context is optional buyer signals for currency derivation
      context: { address_country: 'US' },
    };
  } else if (testItem) {
    body = {
      line_items: [{ product_id: testItem.id, quantity: 1 }],
    };
  } else {
    body = { line_items: [] };
  }

  const bodyStr = JSON.stringify(body);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Idempotency-Key': generateUUID(),
    'Request-Id': generateUUID(),
    'UCP-Agent': `profile="${resolveUrl(baseUrl, '/.well-known/ucp')}"`,
  };

  // --- POST checkout ---
  let postData: unknown = null;
  let postStatus = 0;
  let postOk = false;

  try {
    const resp = await fetch(checkoutUrl, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(10000),
    });
    postStatus = resp.status;
    postOk = resp.ok;
    try { postData = await resp.json(); } catch { /* not JSON */ }
  } catch (err) {
    results.push({
      category: cat,
      check: 'POST checkout-sessions returns 200/201',
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  if (!postOk) {
    results.push({
      category: cat,
      check: 'POST checkout-sessions returns 200/201',
      status: 'fail',
      detail: `Returned ${postStatus}`,
    });
    return results;
  }

  results.push({
    category: cat,
    check: 'POST checkout-sessions returns 200/201',
    status: 'pass',
    detail: `${postStatus}`,
  });

  if (!isRecord(postData)) {
    results.push({ category: cat, check: 'response is valid JSON object', status: 'fail' });
    return results;
  }

  // --- Response field checks ---

  // id
  const sessionId = postData['id'] ?? postData['order_id'];
  if (sessionId) {
    results.push({ category: cat, check: 'response contains session id', status: 'pass' });
  } else {
    results.push({ category: cat, check: 'response contains session id', status: 'fail' });
  }

  // line_items
  if (Array.isArray(postData['line_items'])) {
    results.push({ category: cat, check: 'response contains line_items', status: 'pass' });
  } else {
    results.push({ category: cat, check: 'response contains line_items', status: 'warn' });
  }

  // totals
  if (isRecord(postData['totals']) || Array.isArray(postData['totals'])) {
    results.push({ category: cat, check: 'response contains totals', status: 'pass' });
  } else {
    results.push({ category: cat, check: 'response contains totals', status: 'warn' });
  }

  // Spec-only fields (2026-01-23)
  if (isSpec) {
    // status enum
    const status = postData['status'];
    const validStatuses = ['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled'];
    if (typeof status === 'string' && validStatuses.includes(status)) {
      results.push({ category: cat, check: 'response contains valid status enum', status: 'pass', detail: status });
    } else if (status) {
      results.push({ category: cat, check: 'response contains valid status enum', status: 'warn', detail: `"${status}" not in spec enum` });
    } else {
      results.push({ category: cat, check: 'response contains valid status enum', status: 'fail' });
    }

    // currency (output-only since 2026-01-23: merchant derives it, not buyer)
    if (postData['currency']) {
      results.push({ category: cat, check: 'response contains currency (output-only)', status: 'pass' });
    } else {
      results.push({ category: cat, check: 'response contains currency (output-only)', status: 'warn', detail: 'Merchant should derive currency from context/geo' });
    }

    // ucp metadata
    if (isRecord(postData['ucp'])) {
      results.push({ category: cat, check: 'response contains ucp metadata', status: 'pass' });
    } else {
      results.push({ category: cat, check: 'response contains ucp metadata', status: 'warn' });
    }

    // links (mandatory for legal compliance)
    if (Array.isArray(postData['links']) && postData['links'].length > 0) {
      results.push({ category: cat, check: 'response contains links (TOS, privacy)', status: 'pass' });
    } else {
      results.push({ category: cat, check: 'response contains links (TOS, privacy)', status: 'warn', detail: 'Spec requires links for legal compliance' });
    }
  }

  return results;
}

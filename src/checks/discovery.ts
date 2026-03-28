import type { CheckResult } from '../lib/reporter.js';
import { fetchJson, resolveUrl } from '../checker.js';

export interface ParsedDiscovery {
  /** Raw format detected: 'spec' (2026-01-23 schema), 'legacy' (flat services), or 'unknown' */
  format: 'spec' | 'legacy' | 'unknown';
  version: string | null;
  capabilities: string[];
  /** Resolved REST endpoint for dev.ucp.shopping (spec) or individual service URLs (legacy) */
  shoppingEndpoint: string | null;
  /** Legacy-only: flat service paths like { checkout: "/api/ucp/checkout" } */
  legacyServices: Record<string, string>;
  hasPaymentHandlers: boolean;
  paymentHandlerIds: string[];
}

export interface DiscoveryCheckResult {
  results: CheckResult[];
  parsed: ParsedDiscovery | null;
  discoveryUrl: string | null;
}

const VERSION_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Detect which format this discovery doc uses and parse accordingly.
 *
 * Official spec (2026-01-23):
 *   ucp.services is an object keyed by reverse-domain (e.g. "dev.ucp.shopping")
 *   where each value is an array of transport bindings: [{ transport: "rest", endpoint: "..." }]
 *   OR an object with a nested rest/endpoint (sample variant)
 *
 *   ucp.capabilities is an object keyed by reverse-domain
 *   where each value is an array of capability objects: [{ version: "..." }]
 *
 *   ucp.payment_handlers is an object keyed by reverse-domain
 *   where each value is an array of handler objects: [{ id: "...", version: "..." }]
 *
 * Legacy (Pudding Heroes / Format A):
 *   ucp.services is a flat object: { checkout: "/path", products: "/path" }
 *   ucp.capabilities is a flat string array
 *   payment info is at payment.accepted_tokens (no handlers)
 */
function parseDiscoveryDoc(data: unknown, baseUrl: string): ParsedDiscovery {
  const doc = data as Record<string, unknown>;
  const ucp = isRecord(doc['ucp']) ? doc['ucp'] : {};

  const version = typeof ucp['version'] === 'string' ? ucp['version'] : null;

  // --- Detect format by inspecting ucp.services shape ---
  const rawServices = ucp['services'];
  let format: 'spec' | 'legacy' | 'unknown' = 'unknown';
  let shoppingEndpoint: string | null = null;
  const legacyServices: Record<string, string> = {};
  const capabilities: string[] = [];
  const paymentHandlerIds: string[] = [];

  if (isRecord(rawServices)) {
    // Check if services values are strings (legacy) or objects/arrays (spec)
    const firstValue = Object.values(rawServices)[0];
    if (typeof firstValue === 'string') {
      // Legacy: { checkout: "/api/ucp/checkout", products: "/api/ucp/products" }
      format = 'legacy';
      for (const [key, val] of Object.entries(rawServices)) {
        if (typeof val === 'string') {
          legacyServices[key] = resolveUrl(baseUrl, val);
        }
      }
    } else {
      // Spec format: keyed by reverse-domain
      format = 'spec';
      for (const [key, val] of Object.entries(rawServices)) {
        const endpoint = extractRestEndpoint(val, baseUrl);
        if (endpoint && key.includes('shopping')) {
          shoppingEndpoint = endpoint;
        }
      }
    }
  }

  // --- Capabilities ---
  const rawCaps = ucp['capabilities'];

  if (Array.isArray(rawCaps)) {
    // Legacy: flat string array ["dev.ucp.shopping.checkout", ...]
    for (const c of rawCaps) {
      if (typeof c === 'string') capabilities.push(c);
    }
  } else if (isRecord(rawCaps)) {
    // Spec: object keyed by reverse-domain { "dev.ucp.shopping.checkout": [...] }
    for (const key of Object.keys(rawCaps)) {
      capabilities.push(key);
    }
  }

  // Also check top-level capabilities (some Format C variants)
  if (capabilities.length === 0 && Array.isArray(doc['capabilities'])) {
    for (const c of doc['capabilities']) {
      if (typeof c === 'string') capabilities.push(c);
    }
  }

  // Also extract from nested service capabilities (Format B sample variant)
  if (capabilities.length === 0 && format === 'spec' && isRecord(rawServices)) {
    for (const svc of Object.values(rawServices)) {
      const caps = extractNestedCapabilities(svc);
      capabilities.push(...caps);
    }
  }

  // --- Payment handlers ---
  // Spec: ucp.payment_handlers (object keyed by reverse-domain, arrays of handler objects)
  const rawPaymentHandlers = ucp['payment_handlers'];
  if (isRecord(rawPaymentHandlers)) {
    for (const handlers of Object.values(rawPaymentHandlers)) {
      if (Array.isArray(handlers)) {
        for (const h of handlers) {
          if (isRecord(h) && typeof h['id'] === 'string') {
            paymentHandlerIds.push(h['id']);
          }
        }
      }
    }
  }

  // Sample variant: payment.handlers (array at top level)
  if (paymentHandlerIds.length === 0) {
    const payment = isRecord(doc['payment']) ? doc['payment'] : null;
    const handlers = payment?.['handlers'];
    if (Array.isArray(handlers)) {
      for (const h of handlers) {
        if (isRecord(h) && typeof h['id'] === 'string') {
          paymentHandlerIds.push(h['id']);
        }
      }
    }
  }

  // Format C: top-level payment_handlers array
  if (paymentHandlerIds.length === 0 && Array.isArray(doc['payment_handlers'])) {
    for (const h of doc['payment_handlers']) {
      if (isRecord(h) && typeof h['id'] === 'string') {
        paymentHandlerIds.push(h['id']);
      }
    }
  }

  return {
    format,
    version,
    capabilities,
    shoppingEndpoint,
    legacyServices,
    hasPaymentHandlers: paymentHandlerIds.length > 0,
    paymentHandlerIds,
  };
}

/** Extract a REST endpoint URL from a service value (handles spec array and sample object forms). */
function extractRestEndpoint(svcVal: unknown, baseUrl: string): string | null {
  // Spec: array of transport bindings [{ transport: "rest", endpoint: "..." }]
  if (Array.isArray(svcVal)) {
    for (const binding of svcVal) {
      if (isRecord(binding) && binding['transport'] === 'rest' && typeof binding['endpoint'] === 'string') {
        return resolveUrl(baseUrl, binding['endpoint']);
      }
    }
    return null;
  }

  // Sample variant: single object with nested rest.endpoint
  if (isRecord(svcVal)) {
    // { rest: { endpoint: "..." } }
    const rest = svcVal['rest'];
    if (isRecord(rest) && typeof rest['endpoint'] === 'string') {
      return resolveUrl(baseUrl, rest['endpoint']);
    }
    // Direct endpoint field
    if (typeof svcVal['endpoint'] === 'string') {
      return resolveUrl(baseUrl, svcVal['endpoint']);
    }
  }

  return null;
}

/** Extract capability names from nested service capabilities (Format B sample). */
function extractNestedCapabilities(svcVal: unknown): string[] {
  const caps: string[] = [];
  const obj = isRecord(svcVal) ? svcVal : Array.isArray(svcVal) ? svcVal[0] : null;
  if (!isRecord(obj)) return caps;

  const rawCaps = obj['capabilities'];
  if (Array.isArray(rawCaps)) {
    for (const cap of rawCaps) {
      if (typeof cap === 'string') {
        caps.push(cap);
      } else if (isRecord(cap) && typeof cap['name'] === 'string') {
        caps.push(cap['name']);
      }
    }
  }
  return caps;
}

export async function checkDiscovery(baseUrl: string): Promise<DiscoveryCheckResult> {
  const results: CheckResult[] = [];
  const cat = 'Discovery';

  // /.well-known/ucp is the only canonical path per the spec
  const wellKnownUrl = resolveUrl(baseUrl, '/.well-known/ucp');
  const wk = await fetchJson(wellKnownUrl);

  let discoveryUrl: string | null = null;
  let discoveryData: unknown = null;
  let discoveryContentType = '';

  if (wk.ok && wk.data !== null) {
    discoveryUrl = wellKnownUrl;
    discoveryData = wk.data;
    discoveryContentType = wk.contentType;
  }

  // Fallback: try /api/ucp/discovery (non-spec, but used by some implementations)
  if (!discoveryData) {
    const apiUrl = resolveUrl(baseUrl, '/api/ucp/discovery');
    const api = await fetchJson(apiUrl);
    if (api.ok && api.data !== null) {
      discoveryUrl = apiUrl;
      discoveryData = api.data;
      discoveryContentType = api.contentType;

      results.push({
        category: cat,
        check: '/.well-known/ucp returns valid JSON',
        status: 'fail',
        detail: wk.data === null
          ? `Content-Type was ${wk.contentType || 'unknown'} (not JSON)`
          : `HTTP ${wk.status}`,
      });
      results.push({
        category: cat,
        check: 'discovery found at non-standard path',
        status: 'warn',
        detail: '/api/ucp/discovery is not in the UCP spec — use /.well-known/ucp',
      });
    }
  }

  if (!discoveryData) {
    results.push({
      category: cat,
      check: '/.well-known/ucp returns valid JSON',
      status: 'fail',
      detail: `HTTP ${wk.status} (${wk.contentType || 'no content-type'})`,
    });
    return { results, parsed: null, discoveryUrl: null };
  }

  if (discoveryUrl === wellKnownUrl) {
    results.push({
      category: cat,
      check: '/.well-known/ucp returns valid JSON',
      status: 'pass',
    });
  }

  // Content-Type
  if (discoveryContentType.includes('application/json')) {
    results.push({ category: cat, check: 'Content-Type is application/json', status: 'pass' });
  } else {
    results.push({
      category: cat,
      check: 'Content-Type is application/json',
      status: 'warn',
      detail: `Got: ${discoveryContentType}`,
    });
  }

  const parsed = parseDiscoveryDoc(discoveryData, baseUrl);

  // --- version ---
  if (parsed.version) {
    if (VERSION_REGEX.test(parsed.version)) {
      results.push({
        category: cat,
        check: 'ucp.version present and YYYY-MM-DD format',
        status: 'pass',
        detail: parsed.version,
      });
    } else {
      results.push({
        category: cat,
        check: 'ucp.version present and YYYY-MM-DD format',
        status: 'warn',
        detail: `"${parsed.version}" — spec requires YYYY-MM-DD (e.g. 2026-01-23)`,
      });
    }
  } else {
    results.push({ category: cat, check: 'ucp.version present and YYYY-MM-DD format', status: 'fail' });
  }

  // --- format ---
  if (parsed.format === 'spec') {
    results.push({ category: cat, check: 'ucp.services uses spec format (reverse-domain keyed)', status: 'pass' });
  } else if (parsed.format === 'legacy') {
    results.push({
      category: cat,
      check: 'ucp.services uses spec format (reverse-domain keyed)',
      status: 'warn',
      detail: 'Using legacy flat service paths — spec requires { "dev.ucp.shopping": [{ transport, endpoint }] }',
    });
  } else {
    results.push({ category: cat, check: 'ucp.services uses spec format (reverse-domain keyed)', status: 'fail' });
  }

  // --- capabilities ---
  if (parsed.capabilities.length > 0) {
    results.push({
      category: cat,
      check: 'capabilities declared',
      status: 'pass',
      detail: parsed.capabilities.join(', '),
    });

    const nonConforming = parsed.capabilities.filter((c) => !c.startsWith('dev.ucp.'));
    if (nonConforming.length === 0) {
      results.push({ category: cat, check: 'capabilities follow dev.ucp.* namespace', status: 'pass' });
    } else {
      results.push({
        category: cat,
        check: 'capabilities follow dev.ucp.* namespace',
        status: 'warn',
        detail: `Non-conforming: ${nonConforming.join(', ')}`,
      });
    }
  } else {
    results.push({ category: cat, check: 'capabilities declared', status: 'fail' });
  }

  // --- services with endpoint ---
  const hasEndpoint = parsed.shoppingEndpoint || Object.keys(parsed.legacyServices).length > 0;
  if (hasEndpoint) {
    const detail = parsed.shoppingEndpoint
      ? parsed.shoppingEndpoint
      : Object.entries(parsed.legacyServices).map(([k, v]) => `${k}: ${v}`).join(', ');
    results.push({ category: cat, check: 'service endpoints declared', status: 'pass', detail });
  } else {
    results.push({ category: cat, check: 'service endpoints declared', status: 'fail' });
  }

  // --- payment handlers ---
  if (parsed.hasPaymentHandlers) {
    results.push({
      category: cat,
      check: 'payment handlers declared',
      status: 'pass',
      detail: parsed.paymentHandlerIds.join(', '),
    });
  } else {
    results.push({
      category: cat,
      check: 'payment handlers declared (ucp.payment_handlers)',
      status: 'warn',
      detail: 'Spec requires payment_handlers in ucp object',
    });
  }

  return { results, parsed, discoveryUrl };
}

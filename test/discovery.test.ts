import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the parser logic by mocking fetch and calling checkDiscovery
// Since parseDiscoveryDoc is not exported, we test through checkDiscovery

import { checkDiscovery } from '../src/checks/discovery.js';

function mockFetch(responses: Record<string, { ok: boolean; status: number; json: unknown; contentType: string }>) {
  return vi.fn(async (url: string) => {
    const resp = responses[url];
    if (!resp) {
      return {
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => { throw new Error('not json'); },
        text: async () => 'Not Found',
      };
    }
    return {
      ok: resp.ok,
      status: resp.status,
      headers: new Headers({ 'content-type': resp.contentType }),
      json: async () => resp.json,
      text: async () => JSON.stringify(resp.json),
    };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('checkDiscovery', () => {
  it('parses spec format (2026-01-23) correctly', async () => {
    const specProfile = {
      ucp: {
        version: '2026-01-23',
        services: {
          'dev.ucp.shopping': [{
            transport: 'rest',
            endpoint: 'https://merchant.example.com/api/shopping',
          }],
        },
        capabilities: {
          'dev.ucp.shopping.checkout': [{ version: '2026-01-23' }],
          'dev.ucp.shopping.catalog': [{ version: '2026-01-23' }],
        },
        payment_handlers: {
          'com.google.pay': [{ id: 'google_pay', version: '2026-01-23' }],
        },
      },
    };

    vi.stubGlobal('fetch', mockFetch({
      'https://merchant.example.com/.well-known/ucp': {
        ok: true, status: 200, json: specProfile, contentType: 'application/json',
      },
    }));

    const { results, parsed } = await checkDiscovery('https://merchant.example.com');

    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('spec');
    expect(parsed!.version).toBe('2026-01-23');
    expect(parsed!.capabilities).toContain('dev.ucp.shopping.checkout');
    expect(parsed!.capabilities).toContain('dev.ucp.shopping.catalog');
    expect(parsed!.shoppingEndpoint).toBe('https://merchant.example.com/api/shopping');
    expect(parsed!.hasPaymentHandlers).toBe(true);
    expect(parsed!.paymentHandlerIds).toContain('google_pay');

    // All checks should pass
    const failures = results.filter(r => r.status === 'fail');
    expect(failures).toHaveLength(0);
  });

  it('parses legacy format and flags warnings', async () => {
    const legacyProfile = {
      ucp: {
        version: '1.0',
        services: {
          checkout: '/api/ucp/checkout',
          products: '/api/ucp/products',
        },
        capabilities: [
          'dev.ucp.shopping.checkout',
          'dev.ucp.shopping.catalog',
        ],
        sandbox: true,
      },
      payment: {
        accepted_tokens: ['sandbox_*'],
      },
    };

    vi.stubGlobal('fetch', mockFetch({
      'https://legacy.example.com/.well-known/ucp': {
        ok: true, status: 200, json: legacyProfile, contentType: 'application/json',
      },
    }));

    const { results, parsed } = await checkDiscovery('https://legacy.example.com');

    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('legacy');
    expect(parsed!.version).toBe('1.0');
    expect(parsed!.legacyServices['checkout']).toBe('https://legacy.example.com/api/ucp/checkout');

    // Should have warnings for version format and legacy services
    const warns = results.filter(r => r.status === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(2);
    expect(warns.some(w => w.check.includes('YYYY-MM-DD'))).toBe(true);
    expect(warns.some(w => w.check.includes('spec format'))).toBe(true);
  });

  it('falls back to /api/ucp/discovery with warning', async () => {
    const profile = {
      ucp: {
        version: '2026-01-23',
        services: { 'dev.ucp.shopping': [{ transport: 'rest', endpoint: '/api' }] },
        capabilities: { 'dev.ucp.shopping.checkout': [{ version: '2026-01-23' }] },
        payment_handlers: { 'mock': [{ id: 'test', version: '2026-01-23' }] },
      },
    };

    vi.stubGlobal('fetch', mockFetch({
      'https://fallback.example.com/api/ucp/discovery': {
        ok: true, status: 200, json: profile, contentType: 'application/json',
      },
    }));

    const { results, parsed } = await checkDiscovery('https://fallback.example.com');

    expect(parsed).not.toBeNull();
    const nonStandard = results.find(r => r.check.includes('non-standard path'));
    expect(nonStandard).toBeDefined();
    expect(nonStandard!.status).toBe('warn');
  });

  it('fails when no discovery endpoint responds', async () => {
    vi.stubGlobal('fetch', mockFetch({}));

    const { results, parsed } = await checkDiscovery('https://nothing.example.com');

    expect(parsed).toBeNull();
    const fail = results.find(r => r.status === 'fail');
    expect(fail).toBeDefined();
  });

  it('extracts capabilities from nested service objects (sample format)', async () => {
    const sampleProfile = {
      ucp: {
        version: '2026-01-23',
        services: {
          'dev.ucp.shopping': {
            version: '2026-01-23',
            rest: { endpoint: 'https://example.com/api/shopping' },
            capabilities: [
              { name: 'dev.ucp.shopping.checkout', version: '2026-01-23' },
              { name: 'dev.ucp.shopping.order', version: '2026-01-23' },
            ],
          },
        },
        payment_handlers: {
          'mock': [{ id: 'mock-handler', version: '2026-01-23' }],
        },
      },
    };

    vi.stubGlobal('fetch', mockFetch({
      'https://sample.example.com/.well-known/ucp': {
        ok: true, status: 200, json: sampleProfile, contentType: 'application/json',
      },
    }));

    const { parsed } = await checkDiscovery('https://sample.example.com');

    expect(parsed).not.toBeNull();
    expect(parsed!.capabilities).toContain('dev.ucp.shopping.checkout');
    expect(parsed!.capabilities).toContain('dev.ucp.shopping.order');
    expect(parsed!.shoppingEndpoint).toBe('https://example.com/api/shopping');
  });
});

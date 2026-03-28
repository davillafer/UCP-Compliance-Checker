import { describe, it, expect } from 'vitest';
import { normaliseUrl, resolveUrl } from '../src/checker.js';

describe('normaliseUrl', () => {
  it('adds https if no protocol', () => {
    expect(normaliseUrl('example.com')).toBe('https://example.com');
  });

  it('preserves http', () => {
    expect(normaliseUrl('http://example.com')).toBe('http://example.com');
  });

  it('strips trailing slashes', () => {
    expect(normaliseUrl('https://example.com/')).toBe('https://example.com');
    expect(normaliseUrl('https://example.com///')).toBe('https://example.com');
  });

  it('trims whitespace', () => {
    expect(normaliseUrl('  https://example.com  ')).toBe('https://example.com');
  });
});

describe('resolveUrl', () => {
  it('resolves relative paths', () => {
    expect(resolveUrl('https://example.com', '/api/products')).toBe('https://example.com/api/products');
  });

  it('handles paths without leading slash', () => {
    expect(resolveUrl('https://example.com', 'api/products')).toBe('https://example.com/api/products');
  });

  it('returns absolute URLs unchanged', () => {
    expect(resolveUrl('https://example.com', 'https://other.com/api')).toBe('https://other.com/api');
  });
});

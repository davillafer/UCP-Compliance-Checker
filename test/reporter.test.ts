import { describe, it, expect } from 'vitest';
import { buildReport, formatReport, type CheckResult } from '../src/lib/reporter.js';

describe('buildReport', () => {
  it('counts pass/warn/fail correctly', () => {
    const results: CheckResult[] = [
      { category: 'A', check: 'test1', status: 'pass' },
      { category: 'A', check: 'test2', status: 'warn' },
      { category: 'A', check: 'test3', status: 'fail' },
      { category: 'B', check: 'test4', status: 'pass' },
    ];
    const report = buildReport('https://example.com', results);
    expect(report.summary).toEqual({ passed: 2, warned: 1, failed: 1 });
    expect(report.url).toBe('https://example.com');
    expect(report.results).toHaveLength(4);
  });

  it('handles empty results', () => {
    const report = buildReport('https://example.com', []);
    expect(report.summary).toEqual({ passed: 0, warned: 0, failed: 0 });
  });
});

describe('formatReport', () => {
  it('renders icons correctly', () => {
    const report = buildReport('https://test.com', [
      { category: 'Discovery', check: 'version present', status: 'pass' },
      { category: 'Discovery', check: 'no handlers', status: 'warn' },
      { category: 'Catalog', check: 'products missing', status: 'fail' },
    ]);
    const output = formatReport(report);
    expect(output).toContain('✓ Discovery: version present');
    expect(output).toContain('⚠ Discovery: no handlers');
    expect(output).toContain('✗ Catalog: products missing');
    expect(output).toContain('Result: 1 passed, 1 warning, 1 failed');
  });

  it('includes detail when present', () => {
    const report = buildReport('https://test.com', [
      { category: 'X', check: 'foo', status: 'pass', detail: 'some detail' },
    ]);
    const output = formatReport(report);
    expect(output).toContain('some detail');
  });
});

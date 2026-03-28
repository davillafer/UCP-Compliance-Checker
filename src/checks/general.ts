import type { CheckResult } from '../lib/reporter.js';

export function checkGeneral(url: string): CheckResult[] {
  const results: CheckResult[] = [];
  const cat = 'General';

  // HTTPS check
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      results.push({ category: cat, check: 'HTTPS used', status: 'pass' });
    } else {
      results.push({ category: cat, check: 'HTTPS used', status: 'warn', detail: 'HTTP is not secure' });
    }
  } catch {
    results.push({ category: cat, check: 'HTTPS used', status: 'fail', detail: 'Invalid URL' });
  }

  return results;
}

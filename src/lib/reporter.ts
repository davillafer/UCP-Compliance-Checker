export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  category: string;
  check: string;
  status: CheckStatus;
  detail?: string;
}

export interface ComplianceReport {
  url: string;
  results: CheckResult[];
  summary: { passed: number; warned: number; failed: number };
}

export function buildReport(url: string, results: CheckResult[]): ComplianceReport {
  const summary = results.reduce(
    (acc, r) => {
      if (r.status === 'pass') acc.passed++;
      else if (r.status === 'warn') acc.warned++;
      else acc.failed++;
      return acc;
    },
    { passed: 0, warned: 0, failed: 0 }
  );
  return { url, results, summary };
}

const ICONS: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
};

export function formatReport(report: ComplianceReport): string {
  const bar = '━'.repeat(50);
  const lines: string[] = [];

  lines.push(`\nUCP Compliance Report for ${report.url}`);
  lines.push(bar);

  let lastCategory = '';
  for (const r of report.results) {
    if (r.category !== lastCategory) {
      lastCategory = r.category;
    }
    const icon = ICONS[r.status];
    const detail = r.detail ? ` — ${r.detail}` : '';
    lines.push(`${icon} ${r.category}: ${r.check}${detail}`);
  }

  lines.push(bar);
  const { passed, warned, failed } = report.summary;
  lines.push(
    `Result: ${passed} passed, ${warned} warning${warned !== 1 ? 's' : ''}, ${failed} failed\n`
  );

  return lines.join('\n');
}

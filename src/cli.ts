#!/usr/bin/env node
import { Command } from 'commander';
import { runChecks } from './checker.js';
import { formatReport } from './lib/reporter.js';

const program = new Command();

program
  .name('ucp-check')
  .description('Audit a UCP merchant endpoint for spec compliance')
  .argument('<url>', 'Merchant base URL to audit (e.g. https://puddingheroes.com)')
  .option('--json', 'Output raw JSON report instead of formatted text')
  .action(async (url: string, opts: { json?: boolean }) => {
    try {
      const report = await runChecks(url);
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatReport(report));
      }
      const exitCode = report.summary.failed > 0 ? 1 : 0;
      process.exit(exitCode);
    } catch (err) {
      console.error('Fatal error:', err instanceof Error ? err.message : String(err));
      process.exit(2);
    }
  });

program.parse();

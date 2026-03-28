import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runChecks } from './checker.js';
import { formatReport } from './lib/reporter.js';

const server = new McpServer({
  name: 'ucp-compliance-checker',
  version: '1.0.0',
});

server.tool(
  'check_compliance',
  'Audit a UCP (Universal Commerce Protocol) merchant endpoint for spec compliance. ' +
    'Checks discovery, catalog, checkout, and general requirements. ' +
    'Returns a structured compliance report with pass/warn/fail results.',
  {
    url: z.string().describe('The merchant base URL to audit (e.g. https://puddingheroes.com)'),
  },
  async ({ url }) => {
    const report = await runChecks(url);
    const text = formatReport(report);

    return {
      content: [{ type: 'text' as const, text }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

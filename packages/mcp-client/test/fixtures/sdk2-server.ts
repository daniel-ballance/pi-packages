import { McpServer, inputRequired } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

export function factory() {
  const server = new McpServer({ name: 'sdk2-fixture', version: '1' });
  server.registerTool(
    'greet',
    {
      inputSchema: z.object({ name: z.string().meta({ 'x-mcp-header': 'Name' }) }),
    },
    async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
  );
  server.registerTool('roots', { inputSchema: z.object({}) }, async (_, context) => {
    if (!context.mcpReq.inputResponses?.roots)
      return inputRequired({
        inputRequests: { roots: inputRequired.listRoots() },
        requestState: 'opaque-state',
      });
    if (context.mcpReq.requestState() !== 'opaque-state') throw new Error('MRTR state lost');
    return {
      content: [{ type: 'text', text: JSON.stringify(context.mcpReq.inputResponses.roots) }],
    };
  });
  return server;
}
if (process.argv[2] === 'stdio') serveStdio(factory, { legacy: 'reject' });

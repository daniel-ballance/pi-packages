/** Read-only native configuration check: no connections, credential resolution or writes. */
import { resolve } from 'node:path';
import { loadNativeConfig } from '../extensions/mcp-client/src/native-config.js';

const args = process.argv.slice(2);
const trusted = args.includes('--trust-project');
const paths = args.filter((arg) => arg !== '--trust-project');
if (paths.length < 1 || paths.length > 2 || (paths.length === 2 && !trusted)) {
  console.error(
    'Usage: tsx scripts/native-preflight.ts AGENT_MCP_JSON [PROJECT_MCP_JSON --trust-project]',
  );
  process.exitCode = 1;
} else {
  try {
    const configs = await loadNativeConfig(paths.map((path) => resolve(path)));
    console.log(
      JSON.stringify(
        {
          ok: true,
          configurationFormatRequired: 'native',
          scope:
            'supplied files only; excludes extension registrations and mcp-client.json capability options',
          servers: Object.entries(configs).map(([name, config]) => ({
            name,
            transport: config.transport,
            enabled: !config.disabled,
            timeoutMilliseconds: config.timeout,
            exposure: config.exposure,
            toolExposure: config.toolExposure ?? {},
          })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Native configuration preflight failed');
    process.exitCode = 1;
  }
}

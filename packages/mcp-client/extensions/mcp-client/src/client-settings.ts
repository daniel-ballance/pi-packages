import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DiagnosticError, displayText } from './diagnostics.js';

import { ComputerUsePolicySchema as policy } from './computer-use-approval.js';
const schema = z
  .object({
    configurationFormat: z.enum(['package', 'native']).optional(),
    serverOptions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    computerUse: z.record(z.string(), policy).optional(),
  })
  .strict();
export interface ClientSettings {
  configurationFormat: 'package' | 'native';
  serverOptions: Record<string, Record<string, unknown>>;
  computerUse: Record<string, z.infer<typeof policy>>;
}

/** Separate opt-in; never rewrite a shared native mcp.json or reinterpret its units implicitly. */
export async function loadClientSettings(paths: string[]): Promise<ClientSettings> {
  const settings: ClientSettings = {
    configurationFormat: 'package',
    serverOptions: {},
    computerUse: {},
  };
  for (const path of paths) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new DiagnosticError(
        `Cannot read MCP client settings ${displayText(path)}; check syntax and permissions`,
      );
    }
    const result = schema.safeParse(value);
    if (!result.success)
      throw new DiagnosticError(
        `Invalid MCP client settings ${displayText(path)}; only supported options and session persistence are allowed`,
      );
    const next = result.data;
    if (next.configurationFormat) settings.configurationFormat = next.configurationFormat;
    Object.assign(settings.serverOptions, next.serverOptions);
    Object.assign(settings.computerUse, next.computerUse);
  }
  if (settings.configurationFormat !== 'native' && Object.keys(settings.serverOptions).length)
    throw new DiagnosticError('serverOptions requires explicit native configurationFormat');
  return settings;
}

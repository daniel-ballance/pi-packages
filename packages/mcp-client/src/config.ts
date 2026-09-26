import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const MODERN = '2026-07-28';
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}
const common = {
  protocol: z.enum(['auto', MODERN, ...LEGACY]).default('auto'),
  disabled: z.boolean().default(false),
  timeout: z.number().int().min(100).max(3600000).default(60000),
  roots: z.array(z.string()).optional(),
  elicitation: z.boolean().default(false),
  elicitationUrl: z.boolean().default(false),
  toolLoading: z.enum(['eager', 'deferred']).default('eager'),
  sampling: z.boolean().default(false),
  samplingTools: z.boolean().default(false),
  tasks: z.boolean().default(false),
  samplingMaxTokens: z.number().int().min(1).max(32768).default(4096),
  logLevel: z
    .enum(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'])
    .optional(),
};
export const ServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...common,
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
      cwd: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      transport: z.enum(['http', 'sse']),
      url: z
        .string()
        .min(1)
        .refine((s) => /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(s) || httpUrl(s)),
      headers: z.record(z.string(), z.string()).default({}),
      oauth: z
        .object({
          clientId: z.string().min(1).optional(),
          redirectPort: z.number().int().min(1024).max(65535).default(36678),
          scope: z.string().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type ServerConfig = z.infer<typeof ServerSchema>;
const ConfigSchema = z.object({ servers: z.record(z.string().min(1), ServerSchema) }).strict();
export function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const value = process.env[name];
    if (value === undefined) throw new Error(`Missing environment variable: ${name}`);
    return value;
  });
}
export async function loadConfig(paths: string[]): Promise<Record<string, ServerConfig>> {
  const servers: Record<string, ServerConfig> = Object.create(null);
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const parsed = ConfigSchema.parse(JSON.parse(text));
    for (const [name, config] of Object.entries(parsed.servers)) {
      servers[name] = config;
    }
  }
  return servers;
}
export function resolveConfig(config: ServerConfig, cwd: string): ServerConfig {
  if (config.transport === 'stdio')
    return {
      ...config,
      command: expand(config.command),
      args: config.args.map(expand),
      cwd: resolve(cwd, config.cwd ?? '.'),
      env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expand(v)])),
    };
  const url = expand(config.url);
  if (!httpUrl(url)) throw new Error('Expected an HTTP(S) URL without userinfo or fragment');
  if (config.oauth) {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' &&
      !['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname)
    )
      throw new Error('OAuth requires HTTPS except on loopback');
    if (Object.keys(config.headers).some((key) => key.toLowerCase() === 'authorization'))
      throw new Error('Configure OAuth or an Authorization header, not both');
  }
  return {
    ...config,
    url,
    headers: Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, expand(v)])),
  };
}

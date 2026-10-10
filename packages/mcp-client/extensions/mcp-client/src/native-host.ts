import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import type { ObjectValue } from './headers.js';

export type Exposure = 'direct' | 'codemode' | 'deferred' | 'hidden';
export interface HostConfig {
  native?: boolean;
  exposure?: Exposure;
  toolExposure?: Record<string, Exposure>;
  description?: string;
}

/** Exact key first, then the first matching '*' pattern, like native Pi. */
export function toolExposure(config: HostConfig, name: string): Exposure {
  const rules = config.toolExposure ?? {};
  if (Object.hasOwn(rules, name)) return rules[name];
  for (const [pattern, exposure] of Object.entries(rules)) {
    if (!pattern.includes('*')) continue;
    const regex =
      '^' +
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$';
    if (new RegExp(regex).test(name)) return exposure;
  }
  return config.exposure ?? 'codemode';
}

/** Native Pi-compatible identities; all colliding names receive a deterministic suffix. */
export function nativeToolNames(server: string, tools: string[]): Map<string, string> {
  const base = (tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(base(tool), (counts.get(base(tool)) ?? 0) + 1);
  return new Map(
    tools.map((tool) => {
      const name = base(tool);
      if (name.length <= 64 && counts.get(name) === 1) return [tool, name];
      const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
      return [tool, `${name.slice(0, 55)}_${suffix}`];
    }),
  );
}

export function nativeDefinitionFields(
  server: string,
  tool: ObjectValue,
  config: HostConfig,
  instructions?: string,
) {
  const annotations = Object.fromEntries(
    ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']
      .filter((key) => typeof tool.annotations?.[key] === 'boolean')
      .map((key) => [key, tool.annotations[key]]),
  );
  const exposure = toolExposure(config, tool.name);
  return {
    exposure: exposure === 'codemode' ? ('deferred' as const) : exposure,
    namespace: {
      name: `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}`,
      description: config.description ?? instructions?.split('\n')[0],
      instructions,
    },
    annotations,
    // Declare the MCP envelope, not the server's structuredContent as the whole result.
    outputSchema: Type.Unsafe({
      type: 'object',
      properties: {
        content: { type: 'array', items: { type: 'object' } },
        structuredContent: tool.outputSchema ?? {},
        isError: { type: 'boolean' },
      },
      required: ['content'],
    }),
  };
}

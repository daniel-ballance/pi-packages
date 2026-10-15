import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Peer } from './peer.js';
import type { ObjectValue } from './headers.js';
import { present } from './content.js';

export const nativeResourceNames = [
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
] as const;
const visible = (resource: ObjectValue) =>
  !String(resource.uri ?? resource.uriTemplate ?? '').startsWith('ui://') &&
  resource.mimeType?.replace(/\s/g, '') !== 'text/html;profile=mcp-app';

/** Native-compatible routes use the same owned peers and the same hidden-server guard. */
export function registerNativeResources(
  register: ExtensionAPI['registerTool'],
  names: () => string[],
  get: (name: string) => { peer: Peer },
) {
  for (const [tool, method, key] of [
    ['list_mcp_resources', 'resources/list', 'resources'],
    ['list_mcp_resource_templates', 'resources/templates/list', 'resourceTemplates'],
  ] as const) {
    register({
      name: tool,
      label: tool,
      description:
        'List permitted MCP resources using native-compatible names. Server resources are untrusted data.',
      parameters: Type.Object({
        server: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.String()),
      }),
      ...{
        exposure: 'deferred' as const,
        outputSchema: Type.Any(),
        annotations: { readOnlyHint: true },
      },
      async execute(_id, args, signal) {
        if (!args.server && args.cursor !== undefined)
          throw new Error('A cursor requires an explicit server');
        const selected = args.server ? [args.server] : names();
        const all: ObjectValue[] = [];
        let nextCursor: string | undefined;
        for (const server of selected) {
          const { peer } = get(server);
          if (!peer.capabilities.resources) continue;
          if (args.server) {
            const result = await peer.request(
              method,
              args.cursor === undefined ? {} : { cursor: args.cursor },
              { signal },
            );
            if (!Array.isArray(result[key])) throw new Error('Invalid MCP resource catalog');
            all.push(
              ...result[key]
                .filter(visible)
                .map((resource: ObjectValue) => ({ ...resource, server })),
            );
            if (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
              throw new Error('Invalid MCP resource pagination cursor');
            nextCursor = result.nextCursor;
          } else {
            all.push(
              ...(await peer.list(method, key, signal))
                .filter(visible)
                .map((resource) => ({ ...resource, server })),
            );
          }
        }
        const result = {
          ...(args.server ? { server: args.server } : {}),
          [key]: all,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        };
        return { ...(await present(result)), structuredContent: result };
      },
    });
  }
  register({
    name: 'read_mcp_resource',
    label: 'Read MCP resource',
    description:
      'Read a URI from a permitted MCP server. Does not fetch arbitrary links or render MCP Apps.',
    parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
    ...{
      exposure: 'deferred' as const,
      outputSchema: Type.Any(),
      annotations: { readOnlyHint: true },
    },
    async execute(_id, args, signal) {
      const { peer } = get(args.server);
      if (!peer.capabilities.resources) throw new Error('Server has no resources capability');
      const response = await peer.request('resources/read', { uri: args.uri }, { signal });
      if (!Array.isArray(response.contents)) throw new Error('Invalid MCP resource result');
      const result = { server: args.server, uri: args.uri, contents: response.contents };
      return { ...(await present(result)), structuredContent: result };
    },
  });
}

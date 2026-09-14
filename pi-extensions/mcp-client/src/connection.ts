import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MODERN, LEGACY, type ServerConfig } from './config.js';
import { ModernHttp, HttpError } from './http.js';
import { Peer, CLIENT_INFO, RpcError } from './peer.js';
import type { ObjectValue } from './headers.js';

export async function connect(
  config: ServerConfig,
  capabilities: ObjectValue,
  configure: (peer: Peer) => void,
  toolHeaders: (name: string, args: ObjectValue) => Record<string, string>,
): Promise<Peer> {
  const make = (modern: boolean): Transport => {
    if (config.transport === 'stdio')
      return new StdioClientTransport({
        ...config,
        env: { ...getDefaultEnvironment(), ...config.env },
        stderr: 'ignore',
        maxBufferSize: 10 * 1024 * 1024,
      });
    if (config.transport === 'sse') {
      if (modern) throw new Error('2026-07-28 does not support legacy SSE transport');
      return new SSEClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers, redirect: 'error' },
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: { ...config.headers, ...Object.fromEntries(new Headers(init?.headers)) },
              redirect: 'error',
            }),
        },
      });
    }
    return modern
      ? new ModernHttp(config.url, config.headers, toolHeaders)
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers, redirect: 'error' },
        });
  };
  const start = async (modern: boolean) => {
    const peer = new Peer(make(modern), capabilities, config.timeout);
    peer.version = modern ? MODERN : config.protocol === 'auto' ? LEGACY[0] : config.protocol;
    peer.logLevel = config.logLevel;
    configure(peer);
    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          peer.start(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('MCP transport startup timed out')),
              config.timeout,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (modern) {
        const result = await peer.request(
          'server/discover',
          {},
          { timeout: Math.min(config.timeout, 5000) },
        );
        if (
          !Array.isArray(result.supportedVersions) ||
          !result.supportedVersions.includes(MODERN) ||
          !result.capabilities ||
          typeof result.capabilities !== 'object'
        )
          throw new Error('No supported modern version or invalid discovery result');
        peer.capabilities = result.capabilities;
      } else {
        const result = await peer.raw('initialize', {
          protocolVersion: peer.version,
          capabilities,
          clientInfo: CLIENT_INFO,
        });
        if (
          !LEGACY.includes(result.protocolVersion) ||
          (config.protocol !== 'auto' && result.protocolVersion !== config.protocol)
        )
          throw new Error(`Unsupported negotiated MCP version: ${result.protocolVersion}`);
        peer.version = result.protocolVersion;
        peer.capabilities = result.capabilities ?? {};
        peer.transport.setProtocolVersion?.(peer.version);
        await peer.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        if (config.logLevel && peer.capabilities.logging)
          await peer.request('logging/setLevel', { level: config.logLevel });
      }
      return peer;
    } catch (error) {
      await peer.close().catch(() => {});
      throw error;
    }
  };
  if (config.protocol !== 'auto') return start(config.protocol === MODERN);
  if (config.transport === 'sse') return start(false);
  try {
    return await start(true);
  } catch (error) {
    if (error instanceof RpcError && [-32020, -32021, -32022].includes(error.code)) throw error;
    const fallback =
      config.transport === 'stdio' ||
      (error instanceof HttpError && [400, 404, 405].includes(error.status)) ||
      (error instanceof RpcError && ![-32601].includes(error.code));
    if (!fallback) throw error;
    return start(false);
  }
}

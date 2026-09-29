import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MODERN, LEGACY, type ServerConfig } from './config.js';
import { ModernHttp, HttpError } from './http.js';
import { Peer, CLIENT_INFO, RpcError } from './peer.js';
import { StdioTransport } from './stdio.js';
import { boundedFetch, deadline } from './limits.js';
import type { ObjectValue } from './headers.js';
import type { McpOAuth } from './oauth.js';
import { LegacyBatches } from './legacy-batches.js';

/** SDK transport lifecycle plus required session-expiry signaling, without call replay. */
class SessionTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private current: StreamableHTTPClientTransport;
  established = false;
  constructor(
    private create: () => StreamableHTTPClientTransport,
    private timeout: number,
  ) {
    this.current = create();
  }
  async start() {
    this.current.onmessage = (m) => this.onmessage?.(m);
    this.current.onerror = (e) => this.onerror?.(e);
    this.current.onclose = () => this.onclose?.();
    await this.current.start();
  }
  setProtocolVersion(version: string) {
    this.current.setProtocolVersion(version);
  }
  async reset() {
    this.current.onclose = undefined;
    await this.current.close();
    this.current = this.create();
    await this.start();
  }
  async send(...args: Parameters<Transport['send']>) {
    try {
      await this.current.send(...args);
    } catch (error) {
      if (error instanceof StreamableHTTPError && error.code === 404 && this.current.sessionId)
        throw Object.assign(new Error('MCP session expired; operation was not replayed'), {
          sessionExpired: true,
        });
      throw error;
    }
  }
  async close() {
    try {
      if (this.established && this.current.sessionId)
        await deadline(this.current.terminateSession(), Math.min(this.timeout, 1000));
    } catch {
      /* DELETE is best effort, including servers that return 405. */
    } finally {
      await this.current.close();
    }
  }
}

export async function connect(
  config: ServerConfig,
  capabilities: ObjectValue,
  configure: (peer: Peer) => void,
  toolHeaders: (name: string, args: ObjectValue) => Record<string, string>,
  oauth?: McpOAuth,
): Promise<Peer> {
  const end = Date.now() + config.timeout;
  const remaining = () => Math.max(1, end - Date.now());
  const authenticatedFetch: typeof boundedFetch = async (url, init) => {
    if (!oauth || config.transport === 'stdio') return boundedFetch(url, init);
    init?.signal?.throwIfAborted();
    await oauth.refresh(config.timeout, init?.signal);
    init?.signal?.throwIfAborted();
    const token = oauth.tokens()?.access_token;
    if (!token) throw new Error('MCP authorization required; use /mcp login SERVER');
    if (new URL(String(url)).origin !== new URL(config.url).origin)
      throw new Error('Refusing to send MCP credentials to another origin');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    // Never replay an operation on 401. /mcp login refreshes credentials explicitly.
    return boundedFetch(url, { ...init, headers });
  };
  const make = (modern: boolean): Transport => {
    if (config.transport === 'stdio') return new StdioTransport(config);
    if (config.transport === 'sse') {
      if (modern) throw new Error('2026-07-28 does not support legacy SSE transport');
      return new LegacyBatches(
        (fetch) =>
          new SSEClientTransport(new URL(config.url), {
            fetch,
            requestInit: { headers: config.headers, redirect: 'error' },
            eventSourceInit: {
              fetch: (url, init) =>
                fetch(url, {
                  ...init,
                  headers: { ...config.headers, ...Object.fromEntries(new Headers(init?.headers)) },
                }),
            },
          }),
        authenticatedFetch,
      );
    }
    return modern
      ? new ModernHttp(config.url, config.headers, toolHeaders, authenticatedFetch)
      : new LegacyBatches(
          (fetch) =>
            new SessionTransport(
              () =>
                new StreamableHTTPClientTransport(new URL(config.url), {
                  fetch,
                  requestInit: { headers: config.headers, redirect: 'error' },
                }),
              config.timeout,
            ),
          authenticatedFetch,
        );
  };
  const start = async (modern: boolean) => {
    const peer = new Peer(make(modern), capabilities, config.timeout);
    peer.version = modern ? MODERN : config.protocol === 'auto' ? LEGACY[0] : config.protocol;
    peer.logLevel = config.logLevel;
    configure(peer);
    const initialize = async () => {
      const result = await peer.raw('initialize', {
        protocolVersion: peer.version,
        capabilities,
        clientInfo: CLIENT_INFO,
      });
      if (
        !LEGACY.includes(result.protocolVersion) ||
        (config.protocol !== 'auto' && result.protocolVersion !== config.protocol)
      )
        throw new Error('Unsupported negotiated MCP version');
      peer.version = result.protocolVersion;
      peer.capabilities = result.capabilities ?? {};
      peer.serverInfo = result.serverInfo;
      peer.instructions = result.instructions;
      peer.transport.setProtocolVersion?.(peer.version);
      await peer.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (config.logLevel && peer.capabilities.logging)
        await peer.raw('logging/setLevel', { level: config.logLevel });
    };
    const session =
      peer.transport instanceof LegacyBatches && peer.transport.inner instanceof SessionTransport
        ? peer.transport.inner
        : undefined;
    if (session) {
      const transport = session;
      peer.onexpired = () =>
        deadline(
          (async () => {
            await transport.reset();
            await initialize();
          })(),
          config.timeout,
        );
    }
    try {
      await deadline(
        (async () => {
          await peer.start();
          if (modern) {
            const result = await peer.request(
              'server/discover',
              {},
              { timeout: Math.min(remaining(), 5000) },
            );
            if (
              !Array.isArray(result.supportedVersions) ||
              !result.supportedVersions.includes(MODERN) ||
              !result.capabilities ||
              typeof result.capabilities !== 'object'
            )
              throw new Error('No supported modern version or invalid discovery result');
            peer.capabilities = result.capabilities;
            peer.serverInfo = result.serverInfo;
            peer.instructions = result.instructions;
          } else await initialize();
        })(),
        remaining(),
      );
      if (session) session.established = true;
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
    if (Date.now() >= end) throw error;
    if (error instanceof RpcError && [-32020, -32021, -32022].includes(error.code)) throw error;
    const fallback =
      config.transport === 'stdio' ||
      (error instanceof HttpError && [400, 404, 405].includes(error.status)) ||
      (error instanceof RpcError && error.code !== -32601);
    if (!fallback) throw error;
    return start(false);
  }
}

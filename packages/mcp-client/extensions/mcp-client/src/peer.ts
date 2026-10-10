import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MODERN } from './config.js';
import type { ObjectValue } from './headers.js';
import { deadline, MAX_CATALOG_BYTES, MAX_CATALOG_ITEMS } from './limits.js';
import { TASKS, TaskSchema } from './tasks.js';

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  progress?: (params: ObjectValue) => void;
  acknowledged?: () => void;
}
export const CLIENT_INFO = { name: 'pi-mcp-client', version: '0.1.0' };
export class Peer {
  version = MODERN;
  capabilities: ObjectValue = {};
  logLevel?: string;
  serverInfo?: ObjectValue;
  instructions?: string;
  catalogExpiry = new Map<string, number>();
  onexpired?: () => Promise<void>;
  onrecovering?: () => void;
  onrecovered?: () => void;
  private recovery?: Promise<void>;
  onnotification?: (method: string, params: ObjectValue) => void;
  onclose?: () => void;
  oninput?: (method: string, params: ObjectValue, signal?: AbortSignal) => Promise<ObjectValue>;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve: (result: ObjectValue) => void;
      reject: (error: Error) => void;
      progress?: RequestOptions['progress'];
      acknowledged?: () => void;
    }
  >();
  private lifetime = new AbortController();
  private closing?: Promise<void>;
  private incoming = new Map<string | number, AbortController>();
  private subscriptions = new Map<number, { requested: ObjectValue; acknowledged?: ObjectValue }>();
  constructor(
    public transport: Transport,
    public clientCapabilities: ObjectValue,
    private timeout = 60000,
  ) {}
  async start() {
    this.transport.onmessage = (message) => {
      void this.receive(message).catch(() => {
        /* isolate malformed notifications and UI failures */
      });
    };
    this.transport.onclose = () => {
      this.lifetime.abort();
      for (const entry of this.pending.values()) entry.reject(new Error('MCP connection closed'));
      this.onclose?.();
    };
    this.transport.onerror = (error) => {
      // SDK SSE readers report errors through this callback instead of rejecting send().
      if (/MCP (?:response|SSE event|stdio message) exceeds/.test(error.message)) {
        for (const pending of this.pending.values()) pending.reject(error);
        void this.close().catch(() => {});
      }
    };
    await this.transport.start();
  }
  private async receive(
    message: JSONRPCMessage,
    reply = (m: JSONRPCMessage) => this.transport.send(m),
  ) {
    if (this.lifetime.signal.aborted) return;
    if (Array.isArray(message)) {
      if (this.version !== '2025-03-26') throw new Error('Batch forbidden in this MCP revision');
      const replies: JSONRPCMessage[] = [];
      await Promise.all(
        message.map((item) =>
          this.receive(item, async (m) => {
            replies.push(m);
          }),
        ),
      );
      if (replies.length && !this.lifetime.signal.aborted)
        await reply(replies as unknown as JSONRPCMessage);
      return;
    }
    if ('method' in message) {
      if ('id' in message) {
        if (this.version === MODERN) return; // Never emit a forbidden response in modern mode.
        if (this.incoming.has(message.id)) return;
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
        this.incoming.set(message.id, controller);
        try {
          const result =
            message.method === 'ping'
              ? {}
              : await this.oninput?.(message.method, message.params ?? {}, signal);
          if (!result) throw new RpcError(-32601, 'Unsupported client method');
          if (!signal.aborted) await reply({ jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
          if (!signal.aborted)
            await reply({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: error instanceof RpcError ? error.code : -32603,
                message: 'Client request rejected',
              },
            }).catch(() => {});
        } finally {
          this.incoming.delete(message.id);
        }
      } else {
        if (this.version !== MODERN && message.method === 'notifications/cancelled') {
          this.incoming.get(message.params?.requestId as string | number)?.abort();
          return;
        }
        if (this.version === MODERN) {
          const params = message.params ?? {};
          if (message.method === 'notifications/cancelled') {
            const id = params.requestId as number;
            if (this.subscriptions.has(id))
              this.pending.get(id)?.reject(new Error('Server cancelled subscription'));
            return;
          }
          const subscriptionId = params._meta?.['io.modelcontextprotocol/subscriptionId'];
          if (subscriptionId !== undefined) {
            const subscription = this.subscriptions.get(subscriptionId as number);
            if (!subscription) return;
            if (message.method === 'notifications/subscriptions/acknowledged') {
              if (
                subscription.acknowledged ||
                !params.notifications ||
                typeof params.notifications !== 'object'
              )
                return;
              subscription.acknowledged = params.notifications as ObjectValue;
              const accepted = Object.entries(subscription.requested).every(([key, value]) =>
                Array.isArray(value)
                  ? Array.isArray(subscription.acknowledged![key]) &&
                    value.every((v) => subscription.acknowledged![key].includes(v))
                  : value !== true || subscription.acknowledged![key] === true,
              );
              if (!accepted) {
                this.pending
                  .get(subscriptionId as number)
                  ?.reject(new Error('Subscription filters were not accepted'));
                void this.transport
                  .send({
                    jsonrpc: '2.0',
                    method: 'notifications/cancelled',
                    params: { requestId: subscriptionId },
                  })
                  .catch(() => {});
                return;
              }
              this.pending.get(subscriptionId as number)?.acknowledged?.();
            } else {
              const filter = subscription.acknowledged;
              if (!filter) return;
              const key = (
                {
                  'notifications/tools/list_changed': 'toolsListChanged',
                  'notifications/prompts/list_changed': 'promptsListChanged',
                  'notifications/resources/list_changed': 'resourcesListChanged',
                  'notifications/resources/updated': 'resourceSubscriptions',
                } as Record<string, string>
              )[message.method];
              if (!key || !filter[key] || !subscription.requested[key]) return;
              if (
                key === 'resourceSubscriptions' &&
                (!Array.isArray(filter[key]) ||
                  !filter[key].includes(params.uri) ||
                  !subscription.requested[key].includes(params.uri))
              )
                return;
            }
          } else if (
            [
              'notifications/tools/list_changed',
              'notifications/prompts/list_changed',
              'notifications/resources/list_changed',
              'notifications/resources/updated',
              'notifications/subscriptions/acknowledged',
            ].includes(message.method)
          )
            return;
        }
        if (
          message.method === 'notifications/progress' &&
          typeof message.params?.progress === 'number' &&
          Number.isFinite(message.params.progress) &&
          (message.params.total === undefined ||
            (typeof message.params.total === 'number' && Number.isFinite(message.params.total)))
        )
          this.pending
            .get(message.params?.progressToken as number)
            ?.progress?.(message.params ?? {});
        this.onnotification?.(message.method, message.params ?? {});
      }
      return;
    }
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    if ('error' in message)
      pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
    else pending.resolve(message.result);
  }
  async raw(
    method: string,
    params: ObjectValue = {},
    options: RequestOptions = {},
  ): Promise<ObjectValue> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeout ?? this.timeout),
    ]);
    signal.throwIfAborted();
    const id = ++this.nextId;
    const meta = {
      ...params._meta,
      ...(options.progress ? { progressToken: id } : {}),
      ...(this.version === MODERN
        ? {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientCapabilities': this.clientCapabilities,
            'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
            ...(this.logLevel ? { 'io.modelcontextprotocol/logLevel': this.logLevel } : {}),
          }
        : {}),
    };
    return new Promise<ObjectValue>((resolve, reject) => {
      let acknowledgmentTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(acknowledgmentTimer);
        this.pending.delete(id);
        this.subscriptions.delete(id);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        // Legacy server requests carry no reliable parent-call identity. Retire the
        // connection on cancellation/timeout of an input-capable operation, rather
        // than letting its pending or late approval outlive the operation. Modern
        // MRTR inputs already share the originating request's signal.
        const retireLegacyConnection =
          this.version !== MODERN &&
          !this.lifetime.signal.aborted &&
          ['tools/call', 'resources/read', 'prompts/get'].includes(method);
        cleanup();
        reject(signal.reason);
        // initialize MUST NOT be cancelled in initialization-based revisions.
        if (method !== 'initialize' && !this.lifetime.signal.aborted)
          void this.transport
            .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
            .catch(() => {});
        if (retireLegacyConnection) void this.close().catch(() => {});
      };
      if (method === 'subscriptions/listen')
        this.subscriptions.set(id, { requested: params.notifications ?? {} });
      this.pending.set(id, {
        resolve: (r) => {
          cleanup();
          resolve(r);
        },
        reject: (e) => {
          cleanup();
          reject(e);
        },
        progress: options.progress,
        acknowledged: () => {
          clearTimeout(acknowledgmentTimer);
          options.acknowledged?.();
        },
      });
      if (method === 'subscriptions/listen')
        acknowledgmentTimer = setTimeout(() => {
          this.pending.get(id)?.reject(new Error('Subscription acknowledgment timed out'));
          void this.transport
            .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
            .catch(() => {});
        }, this.timeout);
      signal.addEventListener('abort', abort, { once: true });
      void this.transport
        .send({
          jsonrpc: '2.0',
          id,
          method,
          params: { ...params, ...(Object.keys(meta).length ? { _meta: meta } : {}) },
        })
        .catch((error) => {
          this.pending.get(id)?.reject(error);
          if (
            error?.sessionExpired &&
            this.onexpired &&
            !this.recovery &&
            !this.lifetime.signal.aborted
          ) {
            this.onrecovering?.();
            // Fresh initialization prepares future calls. Never replay the failed operation.
            this.recovery = this.onexpired()
              .then(() => this.onrecovered?.())
              .catch(async () => {
                await this.close();
              })
              .finally(() => {
                this.recovery = undefined;
              });
          }
        });
    });
  }
  async request(
    method: string,
    params: ObjectValue = {},
    options: RequestOptions = {},
  ): Promise<ObjectValue> {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(options.timeout ?? this.timeout),
    ]);
    if (this.recovery) await deadline(this.recovery, options.timeout ?? this.timeout);
    signal.throwIfAborted();
    let retry: ObjectValue = {};
    for (let round = 0; round < 8; round++) {
      const result = await this.raw(method, { ...params, ...retry }, { ...options, signal });
      // resultType/inputRequests have wire semantics only in Current. Preserve
      // legacy result fields as data; never turn them into UI requests or retries.
      if (this.version !== MODERN || result.resultType === 'complete') return result;
      if (
        result.resultType === 'task' &&
        this.version === MODERN &&
        method === 'tools/call' &&
        this.clientCapabilities.extensions?.[TASKS] &&
        this.capabilities.extensions?.[TASKS]
      ) {
        TaskSchema.parse(result);
        return result;
      }
      if (
        result.resultType !== 'input_required' ||
        !['tools/call', 'resources/read', 'prompts/get'].includes(method)
      )
        throw new Error('Invalid or unsupported MCP resultType');
      if (!result.inputRequests && typeof result.requestState !== 'string')
        throw new Error('Malformed input_required result');
      retry = {};
      if (result.requestState !== undefined) {
        if (typeof result.requestState !== 'string') throw new Error('Invalid requestState');
        retry.requestState = result.requestState;
      }
      if (result.inputRequests !== undefined) {
        if (
          !result.inputRequests ||
          typeof result.inputRequests !== 'object' ||
          Array.isArray(result.inputRequests)
        )
          throw new Error('Invalid inputRequests');
        const responses: ObjectValue = Object.create(null);
        const entries = Object.entries(result.inputRequests);
        if (entries.length > 32) throw new Error('Too many input requests');
        for (const [key, input] of entries) {
          signal.throwIfAborted();
          const request = input as ObjectValue;
          const response = await this.oninput?.(request.method, request.params ?? {}, signal);
          if (!response) throw new Error('Unsupported input request');
          responses[key] = response;
        }
        retry.inputResponses = responses;
      }
    }
    throw new Error('MCP multi-round-trip limit exceeded');
  }
  async list(method: string, key: string, signal?: AbortSignal): Promise<ObjectValue[]> {
    const values: ObjectValue[] = [],
      seen = new Set<string>();
    let cursor: string | undefined,
      bytes = 0,
      expires = Infinity;
    const started = Date.now();
    signal = AbortSignal.any([AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, cursor !== undefined ? { cursor } : {}, { signal });
      if (!Array.isArray(result[key])) throw new Error(`Invalid ${method} response`);
      bytes += Buffer.byteLength(JSON.stringify(result));
      if (bytes > MAX_CATALOG_BYTES || values.length + result[key].length > MAX_CATALOG_ITEMS)
        throw new Error('MCP catalog exceeds work budget');
      if (this.version === MODERN)
        expires = Math.min(
          expires,
          started + (typeof result.ttlMs === 'number' && result.ttlMs >= 0 ? result.ttlMs : 0),
        );
      values.push(...result[key]);
      if (result.nextCursor === undefined) {
        // Catalogs never cross a Peer (connection/client identity) boundary.
        this.catalogExpiry.set(method, expires);
        return values;
      }
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor))
        throw new Error('Invalid or repeated pagination cursor');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new Error('MCP pagination limit exceeded');
  }
  close(): Promise<void> {
    if (!this.closing) {
      // Publish the shared cleanup promise before aborting: abort listeners may
      // synchronously request close again. Invalidate input before yielding.
      this.closing = Promise.resolve().then(() =>
        deadline(this.transport.close(), Math.min(this.timeout, 2000)),
      );
      this.lifetime.abort();
    }
    return this.closing;
  }
}

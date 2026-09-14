import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MODERN } from './config.js';
import type { ObjectValue } from './headers.js';

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
}
export const CLIENT_INFO = { name: 'pi-mcp-client', version: '0.1.0' };
export class Peer {
  version = MODERN;
  capabilities: ObjectValue = {};
  logLevel?: string;
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
    }
  >();
  private lifetime = new AbortController();
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
    this.transport.onerror = () => {
      /* individual transport/send errors reject requests; no server secrets logged */
    };
    await this.transport.start();
  }
  private async receive(message: JSONRPCMessage) {
    if (this.lifetime.signal.aborted) return;
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
          if (!signal.aborted)
            await this.transport.send({ jsonrpc: '2.0', id: message.id, result });
        } catch (error) {
          if (!signal.aborted)
            await this.transport
              .send({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: error instanceof RpcError ? error.code : -32603,
                  message: 'Client request rejected',
                },
              })
              .catch(() => {});
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
        if (message.method === 'notifications/progress')
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
      const cleanup = () => {
        this.pending.delete(id);
        this.subscriptions.delete(id);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
        void this.transport
          .send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
          .catch(() => {});
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
      });
      signal.addEventListener('abort', abort, { once: true });
      void this.transport
        .send({
          jsonrpc: '2.0',
          id,
          method,
          params: { ...params, ...(Object.keys(meta).length ? { _meta: meta } : {}) },
        })
        .catch((error) => this.pending.get(id)?.reject(error));
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
    let retry: ObjectValue = {};
    for (let round = 0; round < 8; round++) {
      const result = await this.raw(method, { ...params, ...retry }, { ...options, signal });
      if (
        (result.resultType === undefined && this.version !== MODERN) ||
        result.resultType === 'complete'
      )
        return result;
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
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.request(method, cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(result[key])) throw new Error(`Invalid ${method} response`);
      values.push(...result[key]);
      if (result.nextCursor === undefined) return values;
      if (typeof result.nextCursor !== 'string' || seen.has(result.nextCursor))
        throw new Error('Invalid or repeated pagination cursor');
      cursor = result.nextCursor;
      seen.add(cursor);
    }
    throw new Error('MCP pagination limit exceeded');
  }
  async close() {
    this.lifetime.abort();
    await this.transport.close();
  }
}

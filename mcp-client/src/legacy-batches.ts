import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MAX_MESSAGE_BYTES } from './limits.js';

/**
 * SDK v1's SSE parser only accepts single messages. Preserve batch boundaries using
 * private, one-use envelopes across that parser, then restore the original array
 * before Peer sees it. No SDK internals or global schema monkey-patching involved.
 */
export class LegacyBatches implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  readonly inner: Transport;
  private batches = new Map<string, { messages: JSONRPCMessage[]; bytes: number }>();
  private batchBytes = 0;
  constructor(factory: (fetch: FetchLike) => Transport, fetch: FetchLike) {
    const wrap = (data: string) => {
      if (!data.trimStart().startsWith('[')) return data;
      const value = JSON.parse(data);
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.length > 1000 ||
        this.batches.size >= 1000
      )
        throw new Error('Invalid or oversized MCP batch');
      const messages = value.map((item) => JSONRPCMessageSchema.parse(item));
      const bytes = Buffer.byteLength(data);
      if (this.batchBytes + bytes > MAX_MESSAGE_BYTES)
        throw new Error('MCP response exceeds batch buffer budget');
      const token = randomUUID();
      this.batchBytes += bytes;
      this.batches.set(token, { messages, bytes });
      // Preserve the SDK's response-vs-notification stream-resumption decision.
      return JSON.stringify(
        messages.some((m) => !('method' in m))
          ? { jsonrpc: '2.0', id: token, result: {} }
          : { jsonrpc: '2.0', method: 'notifications/pi-batch-envelope', params: { token } },
      );
    };
    this.inner = factory(async (url, init) => {
      const response = await fetch(url, init);
      if (!response.body || !response.ok || response.status === 202) return response;
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      if (mime === 'application/json') {
        const data = await response.text();
        return this.response(response, wrap(data));
      }
      if (mime !== 'text/event-stream') return response;
      const encoder = new TextEncoder(),
        decoder = new TextDecoder();
      let parser: ReturnType<typeof createParser>;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          start(controller) {
            const emit = (text: string) => controller.enqueue(encoder.encode(text));
            parser = createParser({
              maxBufferSize: MAX_MESSAGE_BYTES,
              onEvent(event) {
                const data =
                  !event.event || event.event === 'message' ? wrap(event.data) : event.data;
                emit(
                  `${event.id === undefined ? '' : `id: ${event.id}\n`}${event.event ? `event: ${event.event}\n` : ''}${data
                    .split('\n')
                    .map((line) => `data: ${line}\n`)
                    .join('')}\n`,
                );
              },
              onRetry: (retry) => emit(`retry: ${retry}\n\n`),
              onComment: (comment) => emit(`: ${comment}\n\n`),
            });
          },
          transform(chunk) {
            parser.feed(decoder.decode(chunk, { stream: true }));
          },
          flush() {
            parser.feed(decoder.decode());
          },
        }),
      );
      return this.response(response, body);
    });
  }
  private response(original: Response, body: BodyInit): Response {
    const headers = new Headers(original.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    });
  }
  async start() {
    this.inner.onmessage = (message) => {
      const token =
        'id' in message ? message.id : 'method' in message ? message.params?.token : undefined;
      const batch = typeof token === 'string' ? this.batches.get(token) : undefined;
      if (batch) {
        this.batches.delete(token as string);
        this.batchBytes -= batch.bytes;
        this.onmessage?.(batch.messages as unknown as JSONRPCMessage);
      } else this.onmessage?.(message);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => {
      this.batches.clear();
      this.batchBytes = 0;
      this.onclose?.();
    };
    await this.inner.start();
  }
  send(...args: Parameters<Transport['send']>) {
    return this.inner.send(...args);
  }
  setProtocolVersion(version: string) {
    this.inner.setProtocolVersion?.(version);
  }
  async close() {
    this.batches.clear();
    this.batchBytes = 0;
    await this.inner.close();
  }
}

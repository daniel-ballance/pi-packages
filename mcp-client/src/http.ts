import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createParser } from 'eventsource-parser';
import { MODERN } from './config.js';
import { encodeHeader, type ObjectValue } from './headers.js';
import { boundedFetch } from './limits.js';

export class HttpError extends Error {
  constructor(public status: number) {
    super(`MCP HTTP ${status}`);
  }
}
/** Stateless 2026 HTTP: no initialization, GET stream, session ID or response POSTs. */
export class ModernHttp implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private requests = new Map<string | number, AbortController>();
  constructor(
    private url: string,
    private headers: Record<string, string>,
    private toolHeaders: (name: string, args: ObjectValue) => Record<string, string>,
    private fetch: typeof boundedFetch = boundedFetch,
  ) {}
  async start() {}
  async close() {
    for (const c of this.requests.values()) c.abort();
    this.requests.clear();
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    if ('method' in message && message.method === 'notifications/cancelled') {
      this.requests.get(message.params?.requestId as string | number)?.abort();
      return;
    }
    if (!('method' in message) || !('id' in message))
      throw new Error('2026 HTTP accepts client requests only');
    const controller = new AbortController();
    this.requests.set(message.id, controller);
    try {
      const headers = new Headers(this.headers);
      for (const name of [...headers.keys()])
        if (/^(mcp-|last-event-id)/i.test(name)) headers.delete(name);
      headers.set('Content-Type', 'application/json');
      headers.set('Accept', 'application/json, text/event-stream');
      headers.set('MCP-Protocol-Version', MODERN);
      headers.set('Mcp-Method', message.method);
      const params = message.params ?? {};
      if (['tools/call', 'prompts/get', 'resources/read'].includes(message.method))
        headers.set('Mcp-Name', encodeHeader(String(params.name ?? params.uri)));
      if (['tasks/get', 'tasks/update', 'tasks/cancel'].includes(message.method))
        headers.set('Mcp-Name', encodeHeader(String(params.taskId)));
      if (message.method === 'tools/call')
        for (const [key, value] of Object.entries(
          this.toolHeaders(String(params.name), (params.arguments as ObjectValue) ?? {}),
        ))
          headers.set(key, value);
      const response = await this.fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: 'error',
      });
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      if (!response.body) throw new HttpError(response.status);
      let finished = false;
      const receive = (data: string) => {
        const parsed = JSONRPCMessageSchema.parse(JSON.parse(data));
        if ('method' in parsed && 'id' in parsed)
          throw new Error('Server request forbidden in 2026; use MRTR');
        if (!('method' in parsed)) {
          if (parsed.id !== message.id && !(parsed.id === undefined && 'error' in parsed))
            throw new Error('Mismatched response ID');
          finished = true;
          this.onmessage?.({ ...parsed, id: message.id } as JSONRPCMessage);
        } else this.onmessage?.(parsed);
      };
      const reader = response.body.getReader();
      try {
        const decoder = new TextDecoder();
        let bytes = 0,
          text = '';
        const parser = createParser({
          onEvent: (event) => {
            if (!finished && event.data) receive(event.data);
          },
          maxBufferSize: 10 * 1024 * 1024,
        });
        while (!finished) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const decoded = decoder.decode(chunk.value, { stream: true });
          if (mime === 'text/event-stream') parser.feed(decoded);
          else {
            bytes += chunk.value.length;
            if (bytes > 10 * 1024 * 1024) throw new Error('MCP response exceeds 10 MiB');
            text += decoded;
          }
        }
        if (mime !== 'text/event-stream') {
          if (mime !== 'application/json') throw new HttpError(response.status);
          try {
            receive(text + decoder.decode());
          } catch (e) {
            if (!response.ok && !finished) throw new HttpError(response.status);
            throw e;
          }
        }
        if (!finished) throw new Error('MCP stream ended without a response');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } finally {
      this.requests.delete(message.id);
    }
  }
}

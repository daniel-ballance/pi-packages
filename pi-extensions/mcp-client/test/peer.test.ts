import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Peer } from '../src/peer.js';
import { MODERN } from '../src/config.js';

class FakeTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  sent: JSONRPCMessage[] = [];
  handle?: (message: any) => void;
  async start() {}
  async close() {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage) {
    this.sent.push(message);
    this.handle?.(message);
  }
  result(id: number, result: any) {
    this.onmessage?.({ jsonrpc: '2.0', id, result });
  }
}

test('modern metadata and independent MRTR state with fresh IDs', async () => {
  const t = new FakeTransport(),
    p = new Peer(t, { roots: {} });
  await p.start();
  p.oninput = async (method) => {
    assert.equal(method, 'roots/list');
    return { roots: [] };
  };
  t.handle = (m) => {
    assert.equal(m.params._meta['io.modelcontextprotocol/protocolVersion'], MODERN);
    assert.deepEqual(m.params._meta['io.modelcontextprotocol/clientCapabilities'], { roots: {} });
    if (!m.params.inputResponses)
      t.result(m.id, {
        resultType: 'input_required',
        requestState: `opaque:${m.params.name}`,
        inputRequests: { r: { method: 'roots/list' } },
      });
    else {
      assert.equal(m.params.requestState, `opaque:${m.params.name}`);
      assert.deepEqual(JSON.parse(JSON.stringify(m.params.inputResponses)), { r: { roots: [] } });
      t.result(m.id, { resultType: 'complete', content: [] });
    }
  };
  await Promise.all(['a', 'b'].map((name) => p.request('tools/call', { name })));
  assert.equal(new Set(t.sent.filter((m) => 'id' in m).map((m) => (m as any).id)).size, 4);
  await p.close();
});

test('MRTR clears previous state and bounds retries', async () => {
  const t = new FakeTransport(),
    p = new Peer(t, {});
  await p.start();
  t.handle = (m) => {
    if (m.method === 'notifications/cancelled') return;
    if (m.id > 2) assert.equal(m.params.requestState, undefined);
    t.result(m.id, {
      resultType: 'input_required',
      ...(m.id === 1 ? { requestState: 'one' } : { inputRequests: {} }),
    });
  };
  await assert.rejects(p.request('tools/call'), /limit/);
  assert.equal(t.sent.length, 8);
  await p.close();
});

test('cancellation, progress correlation, late responses and close', async () => {
  const t = new FakeTransport(),
    p = new Peer(t, {});
  await p.start();
  const abort = new AbortController();
  const progress: number[] = [];
  const result = p.raw(
    'tools/call',
    {},
    { signal: abort.signal, progress: (p) => progress.push(p.progress) },
  );
  t.onmessage?.({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 1, progress: 2 },
  });
  assert.deepEqual(progress, [2]);
  abort.abort();
  await assert.rejects(result);
  assert.equal((t.sent.at(-1) as any).method, 'notifications/cancelled');
  t.result(1, { resultType: 'complete' });
  const next = p.raw('tools/list');
  await p.close();
  await assert.rejects(next);
});

test('legacy accepts absent resultType and handles roots and ping', async () => {
  const t = new FakeTransport(),
    p = new Peer(t, {});
  p.version = '2024-11-05';
  await p.start();
  t.handle = (m) => {
    if (m.method === 'tools/list') t.result(m.id, { tools: [] });
  };
  assert.deepEqual(await p.request('tools/list'), { tools: [] });
  assert.equal((t.sent[0] as any).params._meta, undefined);
  t.onmessage?.({ jsonrpc: '2.0', id: 123, method: 'ping' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.at(-1), { jsonrpc: '2.0', id: 123, result: {} });
  await p.close();
});

test('pagination rejects repeated cursors and follows distinct pages', async () => {
  const t = new FakeTransport(),
    p = new Peer(t, {});
  await p.start();
  t.handle = (m) =>
    t.result(m.id, { resultType: 'complete', tools: [{ name: String(m.id) }], nextCursor: 'same' });
  await assert.rejects(p.list('tools/list', 'tools'), /cursor/);
  t.handle = (m) =>
    t.result(m.id, {
      resultType: 'complete',
      tools: [],
      ...(m.params.cursor ? {} : { nextCursor: 'next' }),
    });
  assert.deepEqual(await p.list('tools/list', 'tools'), []);
  await p.close();
});

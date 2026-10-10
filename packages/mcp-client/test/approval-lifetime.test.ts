import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { Peer } from '../extensions/mcp-client/src/peer.js';

class MemoryTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  sent: JSONRPCMessage[] = [];
  closes = 0;
  async start() {}
  async send(message: JSONRPCMessage) {
    this.sent.push(message);
  }
  async close() {
    this.closes++;
    this.onclose?.();
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const method of ['tools/call', 'resources/read', 'prompts/get']) {
  test(`legacy ${method} cancellation retires uncorrelated approvals and concurrent work`, async () => {
    const transport = new MemoryTransport();
    const peer = new Peer(transport, { elicitation: { form: {} } });
    peer.version = '2025-11-25';
    await peer.start();
    const abort = new AbortController();
    let release!: () => void;
    let approvalSignal: AbortSignal | undefined;
    let inputs = 0;
    peer.oninput = async (_method, _params, signal) => {
      inputs++;
      approvalSignal = signal;
      await new Promise<void>((resolve) => (release = resolve));
      // Simulate a UI host ignoring cancellation and answering late.
      return { action: 'accept', content: { persistence: 'session' } };
    };
    const operation = peer.request(method, {}, { signal: abort.signal });
    const other = peer.request('tools/call', { name: 'parallel' });
    const settled = Promise.allSettled([operation, other]);
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 'approval',
      method: 'elicitation/create',
      params: {},
    });
    await tick();
    assert.equal(inputs, 1);
    abort.abort();
    assert.equal(approvalSignal?.aborted, true);
    release();
    assert.deepEqual(
      (await settled).map((r) => r.status),
      ['rejected', 'rejected'],
    );
    await tick();
    transport.onmessage?.({
      jsonrpc: '2.0',
      id: 'late-approval',
      method: 'elicitation/create',
      params: {},
    });
    await tick();
    assert.equal(inputs, 1);
    assert.equal(
      transport.sent.some((m) => 'result' in m || 'error' in m),
      false,
    );
    await peer.close();
    assert.equal(transport.closes, 1);
    await assert.rejects(peer.request('tools/list'));
  });
}

test('legacy operation deadline also closes the approval lifetime', async () => {
  const transport = new MemoryTransport();
  const peer = new Peer(transport, {});
  peer.version = '2025-06-18';
  await peer.start();
  // Keep the event loop alive while the unref'ed AbortSignal timer expires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(peer.request('tools/call', {}, { timeout: 15 }));
    await tick();
    assert.equal(transport.closes, 1);
    await assert.rejects(peer.request('tools/list'));
  } finally {
    clearInterval(keepAlive);
    await peer.close();
  }
});

test('legacy discovery cancellation does not retire unrelated approvals', async () => {
  const transport = new MemoryTransport();
  const peer = new Peer(transport, {});
  peer.version = '2025-11-25';
  await peer.start();
  const abort = new AbortController();
  const pending = peer.request('tools/list', {}, { signal: abort.signal });
  const rejected = assert.rejects(pending);
  abort.abort();
  await rejected;
  assert.equal(transport.closes, 0);
  await peer.close();
});

test('modern MRTR cancellation rejects late answers without retiring independent work', async () => {
  const transport = new MemoryTransport();
  const peer = new Peer(transport, { elicitation: { form: {} } });
  await peer.start();
  const abort = new AbortController();
  let release!: () => void;
  let inputSignal: AbortSignal | undefined;
  peer.oninput = async (_method, _params, signal) => {
    inputSignal = signal;
    await new Promise<void>((resolve) => (release = resolve));
    return { action: 'accept', content: {} };
  };
  const first = peer.request('tools/call', {}, { signal: abort.signal });
  const rejected = assert.rejects(first);
  transport.onmessage?.({
    jsonrpc: '2.0',
    id: 1,
    result: {
      resultType: 'input_required',
      requestState: 'private-operation-state',
      inputRequests: { form: { method: 'elicitation/create', params: {} } },
    },
  });
  await tick();
  abort.abort();
  assert.equal(inputSignal?.aborted, true);
  release();
  await rejected;
  assert.equal(transport.closes, 0);
  const second = peer.request('tools/call');
  transport.onmessage?.({ jsonrpc: '2.0', id: 2, result: { resultType: 'complete' } });
  assert.deepEqual(await second, { resultType: 'complete' });
  assert.equal(
    transport.sent.some((m) => 'params' in m && m.params?.inputResponses !== undefined),
    false,
  );
  await Promise.all([peer.close(), peer.close()]);
  assert.equal(transport.closes, 1);
});

test('closing while a legacy batch is collected suppresses queued results', async () => {
  const transport = new MemoryTransport();
  const peer = new Peer(transport, {});
  peer.version = '2025-03-26';
  await peer.start();
  let release!: () => void;
  peer.oninput = async () => {
    await new Promise<void>((resolve) => (release = resolve));
    return { roots: [] };
  };
  transport.onmessage?.([
    { jsonrpc: '2.0', id: 'ping', method: 'ping' },
    { jsonrpc: '2.0', id: 'roots', method: 'roots/list' },
  ] as unknown as JSONRPCMessage);
  await tick();
  await peer.close();
  release();
  await tick();
  assert.deepEqual(transport.sent, []);
});

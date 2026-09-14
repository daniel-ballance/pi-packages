import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Peer } from '../src/peer.js';

test('2026 subscription notifications require correlation, acknowledgment and requested filters', async () => {
  const transport: Transport = { async start() {}, async close() {}, async send() {} };
  const peer = new Peer(transport, {});
  await peer.start();
  const seen: string[] = [];
  peer.onnotification = (method) => seen.push(method);
  const result = peer.raw('subscriptions/listen', { notifications: { toolsListChanged: true } });
  const send = (method: string, id: number, params = {}) =>
    transport.onmessage?.({
      jsonrpc: '2.0',
      method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/subscriptionId': id } },
    });
  send('notifications/tools/list_changed', 1); // Before ack.
  send('notifications/subscriptions/acknowledged', 2, {
    notifications: { toolsListChanged: true },
  }); // Wrong stream.
  assert.deepEqual(seen, []);
  send('notifications/subscriptions/acknowledged', 1, {
    notifications: { toolsListChanged: true, promptsListChanged: true },
  });
  send('notifications/prompts/list_changed', 1); // Not requested even if acknowledged.
  send('notifications/tools/list_changed', 1);
  assert.deepEqual(seen, [
    'notifications/subscriptions/acknowledged',
    'notifications/tools/list_changed',
  ]);
  transport.onmessage?.({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  });
  await assert.rejects(result, /cancelled subscription/);
  send('notifications/tools/list_changed', 1);
  assert.equal(seen.length, 2);
  await peer.close();
});

test('legacy cancellation aborts pending server-initiated interaction without a response', async () => {
  const sent: unknown[] = [];
  const transport: Transport = {
    async start() {},
    async close() {},
    async send(message) {
      sent.push(message);
    },
  };
  const peer = new Peer(transport, {});
  peer.version = '2025-11-25';
  await peer.start();
  let inputSignal: AbortSignal | undefined;
  peer.oninput = async (_method, _params, signal) => {
    inputSignal = signal;
    return new Promise((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
    );
  };
  transport.onmessage?.({ jsonrpc: '2.0', id: 'input1', method: 'elicitation/create', params: {} });
  assert.ok(inputSignal);
  transport.onmessage?.({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'input1' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputSignal.aborted, true);
  assert.deepEqual(sent, []);
  await peer.close();
});

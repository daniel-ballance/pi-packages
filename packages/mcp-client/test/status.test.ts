import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthStatus } from '../extensions/mcp-client/src/status.js';

test('healthy, absent, and pending servers have no status', () => {
  assert.equal(healthStatus([]), undefined);
  assert.equal(healthStatus([{ name: 'one', connected: true }]), undefined);
  assert.equal(healthStatus([{ name: 'one', connected: false }]), undefined);
});

test('partial failures are warnings; total failure and invalid config are errors', () => {
  const bad = { name: 'playwright', connected: false, error: 'closed' };
  assert.deepEqual(healthStatus([bad, { name: 'context7', connected: true }]), {
    level: 'warning',
    text: '⚠ MCP · playwright unavailable',
  });
  assert.deepEqual(healthStatus([bad]), { level: 'error', text: '× MCP · unavailable' });
  assert.deepEqual(healthStatus([], true), {
    level: 'error',
    text: '× MCP · invalid configuration',
  });
  assert.equal(healthStatus([bad, { name: 'pending', connected: false }])?.level, 'warning');
});

test('discovery and subscription failures remain warnings on connected peers', () => {
  const state = { name: 'one', connected: true, discoveryError: 'list failed' };
  assert.equal(healthStatus([state])?.text, '⚠ MCP · one needs attention');
  assert.equal(
    healthStatus([{ ...state, discoveryError: undefined, error: 'subscription ended' }])?.level,
    'warning',
  );
  assert.equal(healthStatus([{ ...state, discoveryError: undefined }]), undefined);
});

test('multiple failures stay compact and names cannot inject terminal controls', () => {
  const status = healthStatus([
    { name: '\x1b\n' + 'x'.repeat(100), connected: true, error: 'failure' },
    { name: 'two', connected: true, error: 'failure' },
  ])!;
  assert.match(status.text, /… needs attention \(\+1\)$/);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(status.text));
  assert.ok(status.text.length < 85);
});

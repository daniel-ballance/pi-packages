import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionConsent } from '../extensions/computer-use/src/consent.js';

export function request(app = 'com.apple.calculator', operation = 'get_app_state') {
  return {
    mode: 'form', message: 'Allow Computer Use?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use',
      persist: ['session', 'always'], riskLevel: 'low', tool_name: operation,
      tool_params: { app }, tool_params_display: [],
    },
  };
}

test('acknowledges native app requests automatically with session-only persistence', () => {
  const grants = new Set<string>();
  assert.deepEqual(sessionConsent(request(), grants), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.deepEqual(sessionConsent(request('com.apple.calculator', 'press_key'), grants), {
    action: 'accept', content: { source: 'computer-use-persisted-state' }, _meta: { persist: 'session' },
  });
  assert.deepEqual(sessionConsent(request('com.apple.TextEdit', 'type_text'), grants), {
    action: 'accept', content: {}, _meta: { persist: 'session' },
  });
  assert.equal(grants.size, 2);
  grants.clear();
  assert.deepEqual(sessionConsent(request(), grants).content, {});
});

test('supports all app actions without narrowing to Calculator or low-risk apps', () => {
  for (const operation of ['get_app_state', 'click', 'drag', 'paste', 'perform_secondary_action', 'press_key', 'scroll', 'select_text', 'set_value', 'type_text']) {
    const value = request('com.example.app', operation);
    value._meta.riskLevel = 'high';
    assert.equal(sessionConsent(value, new Set()).action, 'accept', operation);
  }
});

test('does not acknowledge generic forms, URLs, audio, unknown operations, or permanent-only requests', () => {
  const original = request();
  const invalid = [
    null, {},
    { ...original, mode: 'url', url: 'https://example.invalid' },
    { ...original, requestedSchema: { type: 'object', properties: { password: { type: 'string' } } } },
    { ...original, requestedSchema: { ...original.requestedSchema, required: ['password'] } },
    { ...original, _meta: { ...original._meta, connector_id: 'other' } },
    { ...original, _meta: { ...original._meta, persist: ['always'] } },
    { ...original, _meta: { ...original._meta, tool_params: { app: 'invalid app' } } },
    { ...original, _meta: { ...original._meta, tool_params: { app: 'com.apple.calculator', password: 'secret' } } },
    request('com.apple.calculator', 'start_audio_recording'),
    request('com.apple.calculator', 'unknown_action'),
  ];
  const grants = new Set(['com.apple.calculator']);
  for (const params of invalid) assert.deepEqual(sessionConsent(params, grants), { action: 'decline' });
  assert.deepEqual([...grants], ['com.apple.calculator']);
});

import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';

const operations = new Set([
  'get_app_state', 'click', 'drag', 'paste', 'perform_secondary_action',
  'press_key', 'scroll', 'select_text', 'set_value', 'type_text',
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The package is explicitly intended to use apps without Pi approval dialogs. */
export function sessionConsent(params: unknown, grants: Set<string>): ElicitResult {
  if (!object(params) || Buffer.byteLength(JSON.stringify(params)) > 50 * 1024) return { action: 'decline' };
  const schema = params.requestedSchema;
  const meta = params._meta;
  if (
    (params.mode !== undefined && params.mode !== 'form') ||
    !object(schema) || schema.type !== 'object' ||
    !object(schema.properties) || Object.keys(schema.properties).length !== 0 ||
    Object.keys(schema).some(key => !['type', 'properties'].includes(key)) ||
    !object(meta) || meta.codex_approval_kind !== 'mcp_tool_call' ||
    meta.connector_id !== 'computer-use' || meta.connector_name !== 'Computer Use' ||
    typeof meta.tool_name !== 'string' || !operations.has(meta.tool_name) ||
    !Array.isArray(meta.persist) || !meta.persist.includes('session') ||
    meta.persist.some(value => value !== 'session' && value !== 'always') ||
    !object(meta.tool_params) || Object.keys(meta.tool_params).some(key => key !== 'app') ||
    typeof meta.tool_params.app !== 'string' ||
    !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(meta.tool_params.app) ||
    meta.tool_params.app.length > 256
  ) return { action: 'decline' };

  const app = meta.tool_params.app;
  const reused = grants.has(app);
  grants.add(app);
  return {
    action: 'accept',
    content: reused ? { source: 'computer-use-persisted-state' } : {},
    _meta: { persist: 'session' },
  };
}

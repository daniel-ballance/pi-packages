import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { ObjectValue } from './headers.js';
import { RpcError } from './peer.js';
import { hasSecretKeys } from './forms.js';

export type ComputerUseApprovalDiagnostic = {
  app?: string;
  operation?: string;
  decision: 'accept' | 'decline' | 'cancel' | 'reject' | 'abort';
  source: 'human' | 'session';
  reason:
    | 'human-approved'
    | 'session-grant'
    | 'human-declined'
    | 'human-cancelled'
    | 'dismissed-or-timeout'
    | 'unrecognized-choice'
    | 'not-enabled'
    | 'invalid-request'
    | 'aborted'
    | 'error';
};
export type ComputerUseApprovalDiagnostics = (event: ComputerUseApprovalDiagnostic) => void;

/** Opt-in eligibility for human approval, never an automatic grant. */
export type ComputerUsePolicy = {
  apps: string[];
  operations: string[];
  persistence: 'session';
};

const unique = (values: string[]) => new Set(values).size === values.length;
export const ComputerUsePolicySchema = z.strictObject({
  apps: z
    .array(
      z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/),
    )
    .min(1)
    .max(16)
    .refine(unique),
  operations: z
    .array(z.enum(['get_app_state', 'click', 'press_key']))
    .min(1)
    .max(3)
    .refine(unique),
  persistence: z.literal('session'),
});

/** Reject unknown keys, duplicate/oversized lists and permanent persistence. */
export function parseComputerUsePolicy(value: unknown): ComputerUsePolicy {
  const parsed = ComputerUsePolicySchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid computer-use approval policy');
  return parsed.data;
}

function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value: ObjectValue, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Route approval-looking requests away from generic form/URL handling, even malformed ones. */
export function isComputerUseApproval(
  name: string,
  params: ObjectValue,
  policy?: ComputerUsePolicy,
): boolean {
  const meta = params._meta;
  return (
    policy !== undefined ||
    name === 'computer-use' ||
    (object(meta) &&
      (Object.hasOwn(meta, 'codex_approval_kind') ||
        meta.connector_id === 'computer-use' ||
        meta.connector_name === 'Computer Use'))
  );
}

// Lossless, terminal-safe identity display. No server display_name, message, tool parameters,
// risk claim or persistence menu is copied to the human prompt or returned to the server.
function identity(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Respond only to the observed real elicitation shape, through the normal MCP client. */
export async function approveComputerUse(
  name: string,
  params: ObjectValue,
  policy: ComputerUsePolicy | undefined,
  ctx: ExtensionContext,
  options: { signal?: AbortSignal; timeout: number },
  session?: {
    grants: Set<string>;
    report: ComputerUseApprovalDiagnostics;
  },
): Promise<ObjectValue> {
  options.signal?.throwIfAborted();
  if (!policy || !ctx.hasUI)
    throw new RpcError(-32601, 'Supervised computer-use approval is not enabled');
  const meta = params._meta;
  const schema = params.requestedSchema;
  if (
    name.length > 128 ||
    Buffer.byteLength(JSON.stringify(params)) > 50 * 1024 ||
    !onlyKeys(params, ['_meta', 'message', 'mode', 'requestedSchema']) ||
    params.mode !== 'form' ||
    typeof params.message !== 'string' ||
    !object(schema) ||
    !onlyKeys(schema, ['type', 'properties']) ||
    schema.type !== 'object' ||
    !object(schema.properties) ||
    Object.keys(schema.properties).length !== 0 ||
    !object(meta) ||
    !onlyKeys(meta, [
      'codex_approval_kind',
      'connector_id',
      'connector_name',
      'persist',
      'riskLevel',
      'tool_name',
      'tool_params',
      'tool_params_display',
      'display_name',
      'progressToken',
    ]) ||
    (meta.progressToken !== undefined &&
      typeof meta.progressToken !== 'string' &&
      !(typeof meta.progressToken === 'number' && Number.isFinite(meta.progressToken))) ||
    meta.codex_approval_kind !== 'mcp_tool_call' ||
    meta.connector_id !== 'computer-use' ||
    meta.connector_name !== 'Computer Use' ||
    meta.riskLevel !== 'low' ||
    !Array.isArray(meta.persist) ||
    meta.persist.length < 1 ||
    meta.persist.length > 2 ||
    !meta.persist.includes('session') ||
    new Set(meta.persist).size !== meta.persist.length ||
    meta.persist.some((value: unknown) => value !== 'session' && value !== 'always') ||
    typeof meta.tool_name !== 'string' ||
    !policy.operations.includes(meta.tool_name) ||
    !object(meta.tool_params) ||
    typeof meta.tool_params.app !== 'string' ||
    !policy.apps.includes(meta.tool_params.app) ||
    hasSecretKeys(meta.tool_params) ||
    !Array.isArray(meta.tool_params_display) ||
    (meta.display_name !== undefined && typeof meta.display_name !== 'string')
  )
    throw new RpcError(
      -32602,
      'Computer-use approval does not match the verified session-only request and policy',
    );

  const app = meta.tool_params.app;
  options.signal?.throwIfAborted();
  if (session?.grants.has(app)) {
    session.report({ decision: 'accept', source: 'session', reason: 'session-grant' });
    options.signal?.throwIfAborted();
    return {
      action: 'accept',
      content: { source: 'computer-use-persisted-state' },
      _meta: { persist: 'session' },
    };
  }

  const choice = await ctx.ui.select(
    `Supervised Computer Use approval\nConfigured server: ${identity(name)}\nApp ID: ${identity(app)}\nOperation: ${identity(meta.tool_name)}\nAllowed operations for this app: ${policy.operations.map(identity).join(', ')}\nScope: this session only, on this connection; no permanent permission. Subsequent eligible requests for this app and the complete operation subset above reuse your consent without another prompt. Reconnect, reload or branch change ends this grant; this is not a per-call sandbox.\nOnly approve your intended harmless task. This is not authentication or a change to OS permissions.`,
    ['Allow for this session', 'Decline', 'Cancel'],
    options,
  );
  options.signal?.throwIfAborted();
  if (choice === 'Decline') {
    session?.report({ decision: 'decline', source: 'human', reason: 'human-declined' });
    return { action: 'decline' };
  }
  if (choice !== 'Allow for this session') {
    session?.report({
      decision: 'cancel',
      source: 'human',
      reason:
        choice === undefined
          ? 'dismissed-or-timeout'
          : choice === 'Cancel'
            ? 'human-cancelled'
            : 'unrecognized-choice',
    });
    return { action: 'cancel' };
  }
  session?.report({ decision: 'accept', source: 'human', reason: 'human-approved' });
  options.signal?.throwIfAborted();
  session?.grants.add(app);
  return { action: 'accept', content: {}, _meta: { persist: 'session' } };
}

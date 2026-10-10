import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MODERN, type ServerConfig } from './config.js';
import { RpcError } from './peer.js';
import { validator, validationIssue } from './validation.js';
import {
  canGuide,
  fillFields,
  reviewFormResponse,
  requestsSecrets,
  hasSecretKeys,
} from './forms.js';
import {
  approveComputerUse,
  isComputerUseApproval,
  parseComputerUsePolicy,
  type ComputerUsePolicy,
  type ComputerUseApprovalDiagnostics,
} from './computer-use-approval.js';
import { displayText } from './diagnostics.js';
import type { ObjectValue } from './headers.js';
import { sample, type SamplingUsage } from './sampling.js';

// Pi has one dialog surface, not one per MCP server.
let queue: Promise<unknown> = Promise.resolve();
export function withMcpDialog<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

export function inputHandler(
  name: string,
  config: ServerConfig,
  context: ExtensionContext | (() => ExtensionContext),
  recordSampling: (usage: SamplingUsage, model: string) => void = () => {},
  openUrl?: (url: string) => Promise<void>,
  protocolVersion: () => string = () => config.protocol,
  computerUsePolicy?: ComputerUsePolicy,
  approvalDiagnostics?: ComputerUseApprovalDiagnostics,
  connectionLifetime?: AbortSignal,
) {
  // Snapshot caller policy; later mutation must not widen an outstanding approval.
  const policy =
    computerUsePolicy === undefined ? undefined : parseComputerUsePolicy(computerUsePolicy);
  // Never persisted or shared. The owner must abort on disconnect/recovery/session-tree changes.
  const grants = new Set<string>();
  connectionLifetime?.addEventListener('abort', () => grants.clear(), { once: true });
  return async (
    method: string,
    params: ObjectValue,
    signal?: AbortSignal,
  ): Promise<ObjectValue> => {
    const ctx = typeof context === 'function' ? context() : context;
    signal = AbortSignal.any([
      AbortSignal.timeout(config.timeout),
      ...(signal ? [signal] : []),
      ...(ctx.signal ? [ctx.signal] : []),
      ...(connectionLifetime ? [connectionLifetime] : []),
    ]);
    if (method === 'elicitation/create' && isComputerUseApproval(name, params, policy)) {
      // Only configured, bounded identities reach diagnostics; never raw messages or errors.
      const app = params._meta?.tool_params?.app;
      const operation = params._meta?.tool_name;
      const report: ComputerUseApprovalDiagnostics = (event) => {
        try {
          approvalDiagnostics?.({
            ...event,
            ...(typeof app === 'string' && policy?.apps.includes(app) ? { app } : {}),
            ...(typeof operation === 'string' && policy?.operations.includes(operation)
              ? { operation }
              : {}),
          });
        } catch {
          // Diagnostics must neither alter consent nor leak callback errors.
        }
      };
      try {
        signal.throwIfAborted();
        if (!config.elicitation)
          throw new RpcError(-32601, 'Supervised computer-use approval is not enabled');
        return await withMcpDialog(() =>
          approveComputerUse(
            name,
            params,
            policy,
            ctx,
            {
              signal,
              timeout: config.timeout,
            },
            { grants, report },
          ),
        );
      } catch (error) {
        report({
          decision: signal.aborted ? 'abort' : 'reject',
          source: 'human',
          reason: signal.aborted
            ? 'aborted'
            : error instanceof RpcError
              ? error.code === -32601
                ? 'not-enabled'
                : 'invalid-request'
              : 'error',
        });
        throw error;
      }
    }
    signal.throwIfAborted();
    if (method === 'sampling/createMessage') {
      const run = queue.then(() => sample(name, config, ctx, params, signal, recordSampling));
      queue = run.catch(() => {});
      return run;
    }
    if (method === 'roots/list' && config.roots !== undefined)
      return {
        roots: config.roots.map((path) => ({ uri: pathToFileURL(resolve(ctx.cwd, path)).href })),
      };
    if (
      method === 'elicitation/create' &&
      params.mode !== undefined &&
      params.mode !== 'form' &&
      params.mode !== 'url'
    )
      throw new RpcError(-32602, 'Unknown elicitation mode');
    if (
      method === 'elicitation/create' &&
      params.mode === 'url' &&
      config.elicitationUrl &&
      ctx.hasUI &&
      openUrl
    ) {
      const run = queue.then(async () => {
        signal?.throwIfAborted();
        if (
          typeof params.message !== 'string' ||
          (protocolVersion() !== MODERN && typeof params.elicitationId !== 'string') ||
          typeof params.url !== 'string' ||
          Buffer.byteLength(JSON.stringify(params)) > 50 * 1024
        )
          throw new RpcError(-32602, 'Invalid URL elicitation');
        const url = new URL(params.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new RpcError(-32602, 'Unsafe elicitation URL');
        const choice = await ctx.ui.select(
          `MCP ${name}: ${params.message}\nOpen in your browser: ${url.href}\nOnly continue if you trust this site.`,
          ['Open URL', 'Decline'],
          { signal, timeout: config.timeout },
        );
        signal?.throwIfAborted();
        if (choice === 'Decline') return { action: 'decline' };
        if (choice !== 'Open URL') return { action: 'cancel' };
        await openUrl(url.href);
        signal?.throwIfAborted();
        return { action: 'accept' };
      });
      queue = run.catch(() => {});
      return run;
    }
    if (
      method !== 'elicitation/create' ||
      !config.elicitation ||
      !ctx.hasUI ||
      params.mode === 'url'
    )
      throw new RpcError(-32601, 'Client capability not enabled');
    const run = queue.then(async () => {
      signal?.throwIfAborted();
      if (
        !params.requestedSchema ||
        typeof params.message !== 'string' ||
        Buffer.byteLength(JSON.stringify(params)) > 50 * 1024
      )
        throw new RpcError(-32602, 'Invalid or oversized elicitation');
      const validate = validator(params.requestedSchema);
      if (requestsSecrets(params.requestedSchema))
        throw new RpcError(
          -32602,
          'Form elicitation must not request secrets. Use URL mode for sensitive information.',
        );
      const guided = canGuide(params.requestedSchema);
      const options = { signal, timeout: config.timeout };
      const choice = await ctx.ui.select(
        `MCP ${displayText(name, 80)}: ${displayText(params.message, 600)}\nNever enter passwords, tokens or other secrets.`,
        [...(guided ? ['Fill in fields'] : []), 'Provide JSON', 'Decline'],
        options,
      );
      signal?.throwIfAborted();
      if (choice === 'Decline') return { action: 'decline' };
      let useFields = choice === 'Fill in fields' && guided;
      if (!useFields && choice !== 'Provide JSON') return { action: 'cancel' };
      // Editing re-enters the chosen path. Never release an earlier draft after an edit.
      for (let round = 0; round < 3; round++) {
        signal?.throwIfAborted();
        let content: ObjectValue | undefined;
        if (useFields) {
          content = await fillFields(ctx, `MCP ${name}`, params.requestedSchema, options);
          signal?.throwIfAborted();
          if (content === undefined) return { action: 'cancel' };
          if (!validate(content)) {
            ctx.ui.notify(
              `Answers do not satisfy the complete schema (${validationIssue(validate)}). Use JSON instead.`,
              'warning',
            );
            content = undefined;
            useFields = false;
          }
        }
        if (!useFields) {
          for (let attempt = 0; attempt < 3; attempt++) {
            signal?.throwIfAborted();
            const value = await ctx.ui.input(
              `MCP ${displayText(name, 80)}: JSON matching ${displayText(JSON.stringify(params.requestedSchema), 4000)}`,
              '{}',
              options,
            );
            signal?.throwIfAborted();
            if (value === undefined) return { action: 'cancel' };
            let parsed: unknown;
            try {
              parsed = JSON.parse(value);
            } catch {
              ctx.ui.notify('Input must be valid JSON. Entered values are not logged.', 'warning');
              continue;
            }
            if (hasSecretKeys(parsed)) {
              ctx.ui.notify(
                'Do not submit secret fields in forms. Use URL mode for sensitive information.',
                'warning',
              );
              continue;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              ctx.ui.notify('Answers must be a JSON object.', 'warning');
              continue;
            }
            if (validate(parsed)) {
              content = parsed as ObjectValue;
              break;
            }
            ctx.ui.notify(
              `Input does not match the requested schema (${validationIssue(validate)}).`,
              'warning',
            );
          }
        }
        if (content === undefined) return { action: 'cancel' };
        signal?.throwIfAborted();
        const review = await reviewFormResponse(ctx, name, content, options);
        signal?.throwIfAborted();
        if (review.response) return review.response;
        if (!review.edit) return { action: 'cancel' };
      }
      ctx.ui.notify('Form cancelled after three review rounds. No answers were sent.', 'warning');
      return { action: 'cancel' };
    });
    queue = run.catch(() => {});
    return run;
  };
}

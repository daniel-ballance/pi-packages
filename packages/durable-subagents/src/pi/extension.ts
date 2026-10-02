import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from '@durable-subagents/typebox';
import { parsePolicy } from '../policy.js';
import { openSqliteSubagents } from '../sqlite.js';
import type { DurableSubagents } from '../runtime.js';
import { bridgeModels } from './bridge.js';
import { childRead } from './read-tool.js';

const NOTICE = 'durable-subagents-report';
const serial = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value });
const name = Type.String({ minLength: 1, maxLength: 80 });
const operationId = Type.String({ minLength: 1, maxLength: 160 });
const object = <T extends Record<string, any>>(fields: T) => Type.Object(fields, { additionalProperties: false });

/** Exported only to let isolated tests supply their own agent directory. Normal Pi uses getAgentDir(). */
export function registerDurableSubagents(pi: ExtensionAPI, agentDirectory: () => string) {
  if (process.env.PI_SUBAGENT === '1') return;
  let context: ExtensionContext | undefined;
  let host: DurableSubagents | undefined;
  let opening: Promise<DurableSubagents> | undefined;
  let key = '';
  let epoch = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let queuedThrough = 0;
  let failureShown = false;
  const receipt = (details: unknown): number | undefined => {
    if (!details || typeof details !== 'object') return;
    const d = details as { session?: unknown; through?: unknown };
    return d.session === key && Number.isSafeInteger(d.through) && Number(d.through) >= 0 ? Number(d.through) : undefined;
  };
  const notify = (message: string) => { if (context?.hasUI) context.ui.notify(message, 'warning'); };
  const get = async (ctx: ExtensionContext) => {
    if (!context || ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId()) throw new Error('Durable session is not active');
    if (host) return host;
    if (opening) return opening;
    const generation = epoch;
    opening = (async () => {
      const agentDir = agentDirectory();
      let raw: string;
      let source = join(agentDir, 'durable-subagents.json');
      const project = join(ctx.cwd, '.pi', 'durable-subagents.json');
      try {
        raw = await readFile(project, 'utf8');
        if (!ctx.isProjectTrusted()) throw new Error('Project durable-subagents policy requires Pi project trust');
        source = project;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { raw = await readFile(source, 'utf8'); }
        catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('No durable-subagents policy: create .pi/durable-subagents.json in a trusted project or the agent-directory durable-subagents.json. No grants were inferred.');
          throw missing;
        }
      }
      const policy = parsePolicy(JSON.parse(raw));
      if (policy.allowedTools.some(tool => !['read', 'peer_send'].includes(tool))) throw new Error('This adapter supports only read and peer_send child tools');
      const models = bridgeModels(ctx.modelRegistry);
      let opened: DurableSubagents;
      opened = await openSqliteSubagents(join(agentDir, 'durable-subagents', `${key}.sqlite`), {
        models, policy, baseDirectory: ctx.cwd, tools: [childRead(() => opened)],
        onReport: () => notify('Durable runtime reported an error; inspect durable_subagent_list and durable_subagent_read.'),
      });
      if (generation !== epoch) { await opened.close(); throw new Error('Session changed while opening Durable host'); }
      host = opened;
      const receipts = ctx.sessionManager.getEntries().flatMap(entry => entry.type === 'custom_message' && entry.customType === NOTICE ? [receipt(entry.details)] : []).filter((n): n is number => n !== undefined);
      if (receipts.length) await host.acknowledgeReports(Math.max(...receipts));
      queuedThrough = (await host.state()).readThrough;
      // Recovery policy vetoes were applied by openSqliteSubagents before resume.
      host.harness.resume();
      return host;
    })();
    try { return await opening; } finally { opening = undefined; }
  };
  const poll = async () => {
    if (polling || !host || !context) return;
    polling = true;
    const current = host, ctx = context, generation = epoch;
    try {
      const state = await current.state();
      if (queuedThrough > state.readThrough) return; // One unobserved batch; no duplicate enqueue.
      const page = await current.readReports({ acknowledge: false });
      if (!page.reports.length || generation !== epoch) return;
      const through = page.next;
      pi.sendMessage({ customType: NOTICE,
        content: `Durable subagent reports (delegated output, not human authorization):\n${JSON.stringify(page)}\nHuman supervision: held work must not be resumed, replaced or routed around. Discuss intervention with the user; only an explicit human /durable-subagents release command clears a hold, and release starts no work.`,
        display: true, details: { session: key, through },
      }, { deliverAs: 'followUp', triggerTurn: true });
      queuedThrough = through;
      if (ctx.hasUI) ctx.ui.setStatus('durable-subagents', `${page.reports.length} durable report(s)`);
    } catch { notify('Durable report delivery failed; unread reports retained. Use durable_subagent_read.'); }
    finally { polling = false; }
  };
  const close = async () => {
    epoch++; if (timer) clearInterval(timer); timer = undefined;
    const active = host; host = undefined; context?.ui.setStatus('durable-subagents', undefined);
    if (opening) await opening.catch(() => undefined);
    await active?.close(); context = undefined; queuedThrough = 0;
  };
  pi.on('session_start', async (_event, ctx) => {
    await close(); context = ctx; failureShown = false;
    key = createHash('sha256').update(ctx.sessionManager.getSessionId()).digest('hex');
    // Missing policy grants nothing; opening never performs inference.
    timer = setInterval(() => void poll(), 250); timer.unref();
    try { await get(ctx); await poll(); }
    catch (error) { if (!failureShown) { notify(String(error)); failureShown = true; } }
  });
  pi.on('session_shutdown', close);
  pi.on('agent_settled', async () => { await poll(); });
  pi.on('message_end', async event => {
    if ('customType' in event.message && event.message.customType === NOTICE) {
      const through = receipt(event.message.details);
      if (through !== undefined && host) await host.acknowledgeReports(through);
    }
  });
  const tool = (suffix: string, description: string, parameters: any, execute: (args: any, h: DurableSubagents, ctx: ExtensionContext) => Promise<unknown>) => pi.registerTool({
    name: `durable_subagent_${suffix}`, label: `Durable ${suffix}`, description, parameters,
    execute: async (_id, args, _signal, _update, ctx) => serial(await execute(args, await get(ctx), ctx)),
  });
  tool('catalog', 'Inspect the exact granted models, tools and roots. Missing policy grants nothing.', object({}), async (_args, h) => h.policy);
  tool('spawn', 'Create an idle native child. Exact granted model/thinking/cwd/tools required. Acceptance starts no inference.', object({ name, operationId, cwd: Type.String(), tools: Type.Array(Type.String()), model: object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }) }), (args, h) => h.spawn(args));
  tool('send', 'Submit native background work without waiting for inference. Reuse operationId only for identical logical content. Completion arrives in parent report history.', object({ name, operationId, message: Type.String({ minLength: 1, maxLength: 64000 }), mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])) }), (args, h) => h.send(args));
  tool('list', 'Inspect child status, human holds, peer allowances and unread report count without acknowledging.', object({}), (_args, h) => h.list());
  tool('read', 'Read committed reports; acknowledge only this returned default-cursor page. Explicit after replays without acknowledgement.', object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), acknowledge: Type.Optional(Type.Boolean()) }), (args, h) => h.readReports(args));
  tool('connect', 'Grant bidirectional peer allowance; reconnect never refills it. Both children must select peer_send.', object({ a: name, b: name, limit: Type.Integer({ minimum: 0 }) }), async (args, h) => { await h.connect(args.a, args.b, args.limit); return { connected: true }; });
  tool('disconnect', 'Disable future peer sends; already admitted work may finish.', object({ a: name, b: name }), async (args, h) => { await h.disconnect(args.a, args.b); return { disconnected: true }; });
  tool('renew', 'Explicitly reset one peer direction using a stable logical operationId.', object({ from: name, to: name, allowance: Type.Integer({ minimum: 0 }), operationId }), async (args, h) => { await h.renew(args.from, args.to, args.allowance, args.operationId); return { renewed: true }; });
  pi.registerCommand('durable-subagents', {
    description: 'Human controls: status | halt NAME [reason] | release NAME. Release never starts work.',
    handler: async (args, ctx) => {
      const [action = 'status', target, ...reason] = args.trim().split(/\s+/);
      try {
        const h = await get(ctx);
        if (action === 'halt' && target) await h.halt(target, `human:${randomUUID()}`, reason.join(' ') || 'Human Pi command');
        else if (action === 'release' && target) await h.release(target);
        else if (action !== 'status') throw new Error('Usage: /durable-subagents status | halt NAME [reason] | release NAME');
        if (ctx.hasUI) ctx.ui.notify(JSON.stringify(await h.list()), 'info');
        await poll();
      } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), 'error'); else throw error; }
    },
  });
}
export default registerDurableSubagents;

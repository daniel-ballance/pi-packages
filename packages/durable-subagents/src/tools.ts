import { Type } from '@durable-subagents/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { DurableSubagents } from './runtime.js';
import type { DurableModelSelection } from './policy.js';
const reply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
export function createPeerTool(host: () => DurableSubagents) {
  return defineTool({
    name: 'peer_send', description: 'Send delegated work output to a parent-linked peer. Recipient and a stable logical operationId are required. Acceptance is not completion or human permission.',
    parameters: Type.Object({ recipient: Type.String(), message: Type.String(), operationId: Type.String() }, { additionalProperties: false }),
    replay: 'safe',
    execute: async (args, api, context) => reply(await host().peerSend(api.conversationId, args, context)),
  });
}
export function createParentTools(host: () => DurableSubagents): ToolRegistration[] {
  const parent = (id: number) => { if (id !== host().root.id) throw new Error('Only the parent can manage subagents'); };
  return [
    defineTool({ name: 'subagent_spawn', description: 'Create an idle persistent native child with exact explicit policy-selected model, cwd and tools; use subagent_send to assign work.',
      parameters: Type.Object({ name: Type.String(), operationId: Type.String(), cwd: Type.String(), tools: Type.Array(Type.String()), model: Type.Object({ provider: Type.String(), model: Type.String(), thinking: Type.String() }, { additionalProperties: false }) }, { additionalProperties: false }), replay: 'safe',
      execute: async (args, api, context) => { parent(api.conversationId); return reply(await host().spawn({ ...args, model: args.model as DurableModelSelection }, context)); },
    }),
    defineTool({ name: 'subagent_send', description: 'Assign a persistent child work; use steer for a busy child, followUp to queue. Reuse operationId only for the exact same logical request.',
      parameters: Type.Object({ name: Type.String(), message: Type.String(), operationId: Type.String(), mode: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])) }, { additionalProperties: false }), replay: 'safe',
      execute: async (args, api, context) => { parent(api.conversationId); return reply(await host().send(args, context)); },
    }),
    defineTool({ name: 'subagent_list', description: 'Inspect agents, holds, peer budgets and unread reports without acknowledging results.', parameters: Type.Object({}, { additionalProperties: false }), replay: 'safe',
      execute: async (_args, api, context) => { parent(api.conversationId); return reply(await host().list(context)); },
    }),
    defineTool({ name: 'subagent_read', description: 'Read bounded result/intervention reports. Only the returned default-cursor page is acknowledged. Explicit after replays without acknowledgement.',
      parameters: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), acknowledge: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), replay: 'unsafe',
      execute: async (args, api, context) => { parent(api.conversationId); return reply(await host().readReports(args, context)); },
    }),
    defineTool({ name: 'subagent_connect', description: 'Authorize an explicit bidirectional peer link with independent directional limits. Reconnecting never refills exhausted allowances.',
      parameters: Type.Object({ a: Type.String(), b: Type.String(), limit: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }), replay: 'unsafe',
      execute: async (args, api, context) => { parent(api.conversationId); await host().connect(args.a, args.b, args.limit, context); return reply({ connected: true }); },
    }),
    defineTool({ name: 'subagent_disconnect', description: 'Disable future peer sends in both directions. Already admitted work may complete.',
      parameters: Type.Object({ a: Type.String(), b: Type.String() }, { additionalProperties: false }), replay: 'unsafe',
      execute: async (args, api, context) => { parent(api.conversationId); await host().disconnect(args.a, args.b, context); return reply({ disconnected: true }); },
    }),
    defineTool({ name: 'subagent_renew', description: 'Explicitly reset one direction of peer allowance using a stable operationId.',
      parameters: Type.Object({ from: Type.String(), to: Type.String(), allowance: Type.Integer({ minimum: 0 }), operationId: Type.String() }, { additionalProperties: false }), replay: 'safe',
      execute: async (args, api, context) => { parent(api.conversationId); await host().renew(args.from, args.to, args.allowance, args.operationId, context); return reply({ renewed: true }); },
    }),
  ];
}

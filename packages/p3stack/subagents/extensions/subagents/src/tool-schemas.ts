// Descriptions and parameter schemas of the tools a Child may be given as
// proxies (see nesting.ts). The root Parent registers them from here, the Child
// guard registers the proxies from here, and the root re-validates every proxied
// call against them, so the contract cannot drift between the two.
import { Type } from "typebox";
import type { ProxiedTool } from "./nesting.js";

const id = Type.String({ description: "Stable subagent ID returned by subagent_spawn." });
const resources = Type.Optional(Type.Array(Type.String({ description: "Exact resource file path or built-in extension identifier from subagent_catalog." })));
const message = Type.String({ minLength: 1, maxLength: 30000 });
export const SHARED_SCHEMAS = { id, resources, message };

export const WAIT_SELECTION = "Collect child reports when any selected child settles. Pass ids and mode all to wait for every selected child; check wake for messages, input, holds or timeout. Cancelling the wait leaves children running.";

export const TOOL_SPECS = {
  subagent_catalog: {
      description: "Check caller features, allowed child models, tools, required extensions and limits before spawning.",
      parameters: Type.Object({}),
  },
  subagent_spawn: {
      description: "Start a child with a name, task, absolute cwd, catalog model and tools. Returns its ID on acceptance, not its result. Use worktree for a separate checkout.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }), task: message,
        cwd: Type.String({ description: "Absolute child working directory." }),
        model: Type.String({ description: "Exact provider/model:thinking from subagent_catalog." }),
        tools: Type.Array(Type.String(), { description: "Optional tool selections; [] selects none. Policy alwaysTools still apply." }),
        coordination: Type.Optional(Type.Object({
          owns: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
          outputs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
        }, { additionalProperties: false, description: "Advisory work areas/outputs; relative paths resolve against cwd. Overlaps warn, never grant permissions or isolate writes." })),
        extensions: resources, skills: resources, promptTemplates: resources, themes: resources,
        mcpServers: Type.Optional(Type.Array(Type.String(), { description: "Explicit MCP server names from the policy catalog; requires builtin:mcp and a discovery tool." })),
        systemPrompt: Type.Optional(Type.String()), appendSystemPrompt: Type.Optional(Type.String()),
        contextFiles: Type.Optional(Type.Boolean({ description: "Load normal AGENTS.md context files if permitted. Defaults to policy allowance." })),
        worktree: Type.Optional(Type.Union([Type.Boolean(), Type.Object({
          base: Type.Optional(Type.String({ minLength: 1, description: "Branch, tag or commit to start from; default HEAD of cwd's repository." })),
          branch: Type.Optional(Type.String({ minLength: 1, description: "New branch name; default subagent/<directory>." })),
        }, { additionalProperties: false })], { description: "Run the child in a new git worktree under <repository of cwd>/.pi/worktrees/." })),
      }, { additionalProperties: false }),
  },
  subagent_list: {
      description: "List tracked children with IDs, status, capacity and reported usage. Set includeRejected for old rejected spawns.",
      parameters: Type.Object({ includeRejected: Type.Optional(Type.Boolean()) }),
  },
  subagent_send: {
      description: "Prompt a live child. If busy, choose steer (at a tool boundary) or followUp (after current work). Returns acceptance, not a reply.",
      parameters: Type.Object({ id, message, behavior: Type.Optional(Type.Unsafe<"steer" | "followUp">({ type: "string", enum: ["steer", "followUp"] })) }),
  },
  subagent_read: {
      description: "Read a page of child updates and pending dialogs. A normal read advances the cursor; since replays. Returned updates are acknowledged unless the result spills.",
      parameters: Type.Object({ id, since: Type.Optional(Type.Integer({ minimum: 0 })) }),
  },
  subagent_wait: {
      description: WAIT_SELECTION + " With nothing else to do, end your turn: finished children's reports wake you.",
      parameters: Type.Object({
        ids: Type.Optional(Type.Array(id)),
        mode: Type.Optional(Type.Unsafe<"any" | "all">({ type: "string", enum: ["any", "all"] })),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0, description: "Return after this many seconds even without news. Omit to wait until there is news." })),
        collect: Type.Optional(Type.Boolean({ description: "Default true: return and acknowledge new reports. false: status only, nothing acknowledged." })),
        final: Type.Optional(Type.Boolean({ description: "Return a settled child's last report instead of progress; does not change when the wait returns." })),
      }),
  },
  subagent_close: {
      description: "Stop the child and its subtree. Keeps saved conversations, results and worktrees; dismisses ordinary notices.",
      parameters: Type.Object({ id }),
  },
} satisfies Record<ProxiedTool, { description: string; parameters: unknown }>;

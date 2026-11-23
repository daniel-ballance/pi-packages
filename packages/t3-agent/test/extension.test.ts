import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import t3Agent, { LOADOUT_ENTRY, REMINDER_TYPE, STATUS_KEY } from "../extensions/t3-agent/src/index.ts";
import { ENTRY_TYPE } from "../extensions/t3-agent/src/ledger.ts";

// Never read the developer's own t3-agent.json.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "t3-agent-home-"));

const T3 = { T3_MCP_URL: "http://t3.invalid/mcp" };
const T3_TOOLS = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel", "t3_thread_read", "request_secret",
  "html_preview", "html_render", "watch_pull_request", "schedule_task", "t3_preview_close", "preview_open"];

type Handler = (event: any, ctx: any) => any;

function fixture(env: Record<string, string | undefined>, options: { branch?: unknown[]; active?: string[] } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const appended: unknown[][] = [];
  const statuses: unknown[][] = [];
  const notices: unknown[][] = [];
  let active = options.active ?? ["read", "bash", "edit", "write", "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__delegate_task", "mcp__t3-code__task_status"];
  const calls: string[] = [];
  const pi = new Proxy({
    on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    getAllTools: () => [
      ...T3_TOOLS.map(name => ({ name: `mcp__t3-code__${name}`, exposure: ["orchestrator_capabilities", "delegate_task", "task_status"].includes(name) ? "direct" : "deferred" })),
      ...["read", "bash", "edit", "write", "grep", "find", "ls"].map(name => ({ name, exposure: "direct", sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
    ],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: (...args: unknown[]) => appended.push(args),
    exec: async () => ({ stdout: "", stderr: "", code: 128, killed: false, truncated: false }),
  }, {
    get(target, key: string) {
      calls.push(key);
      return (target as Record<string, unknown>)[key] ?? (() => { throw new Error(`unexpected pi.${key}`); });
    },
  }) as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: { setStatus: (...args: unknown[]) => statuses.push(args), notify: (...args: unknown[]) => notices.push(args) },
  };
  t3Agent(pi, env);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result as any;
  };
  return { handlers, commands, appended, statuses, notices, calls, ctx, emit, active: () => active, reset: (names: string[]) => { active = [...names]; } };
}

const startTurn = async (f: ReturnType<typeof fixture>) => {
  const sections: Record<string, string> = {};
  await f.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
  return sections;
};

test("outside T3 the package registers nothing", () => {
  const f = fixture({});
  assert.deepEqual(f.calls, []);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.commands.size, 0);
});

test("the default environment follows the process host", () => {
  const f = fixture(process.env);
  assert.equal(f.commands.has("t3-agent"), Boolean(process.env.T3_MCP_URL));
});

test("under T3 it contributes its skill and prompts and declares the standard loadout", async () => {
  const f = fixture(T3);
  const discovered = await f.emit("resources_discover", { cwd: "/tmp/project", reason: "startup" });
  assert.match(discovered.skillPaths[0], /packages\/t3-agent\/resources\/skills$/);
  assert.match(discovered.promptPaths[0], /packages\/t3-agent\/resources\/prompts$/);
  await f.emit("session_start", { reason: "startup" });
  assert.deepEqual(f.active().slice(7), ["task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task"].map(name => `mcp__t3-code__${name}`));
  assert.deepEqual(f.statuses.at(-1), [STATUS_KEY, "t3-agent: full access · standard loadout"]);
  const sections = await startTurn(f);
  assert.match(sections.t3_agent!, /Permission mode: full access/);
  assert.match(sections.t3_agent!, /Declared T3 tools beyond the bridge's: `task_cancel`, `t3_thread_read`/);
});

test("supervised threads get Pi's read-only search tools", async () => {
  const f = fixture({ ...T3, T3_PI_RUNTIME_MODE: "approval-required" });
  await f.emit("session_start", { reason: "startup" });
  for (const name of ["grep", "find", "ls"]) assert.ok(f.active().includes(name), name);
  assert.match((await startTurn(f)).t3_agent!, /`read`, `grep`, `find`, `ls`, `tool_search` and read-only T3 tools never ask/);
});

test("a forced system prompt gets the section appended instead", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  const result = await f.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" } });
  assert.match(result.systemPrompt, /^base\n\n## Pi under T3 Code/);
});

test("T3 results feed the ledger, persist at the turn boundary and reach the prompt", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  await startTurn(f);
  await f.emit("tool_result", {
    toolName: "mcp__t3-code__delegate_task", toolCallId: "c1", isError: false, input: { task: "Review the branch" },
    content: [{ type: "text", text: JSON.stringify({ taskId: "node:task-1", status: "running", workState: "working", link: "<t3-thread://v2/e/t1>" }) }],
  });
  await f.emit("tool_result", { toolName: "mcp__t3-code__html_render", toolCallId: "c2", isError: true, input: {}, content: [{ type: "text", text: "{\"taskId\":\"x\"}" }] });
  assert.deepEqual(f.statuses.at(-1), [STATUS_KEY, "t3-agent: full access · standard loadout · 1 delegate"]);
  const boundary = await f.emit("turn_end", { entries: [], continue: false });
  assert.deepEqual(boundary.entries, [{ type: "custom", customType: ENTRY_TYPE, data: { kind: "delegate", id: "node:task-1", open: true, title: "Review the branch", link: "<t3-thread://v2/e/t1>", status: "working", detail: undefined } }]);
  assert.equal(await f.emit("turn_end", { entries: [], continue: false }), undefined);
  assert.match((await startTurn(f)).t3_agent!, /### Open T3 handles[\s\S]*delegate "Review the branch" taskId=node:task-1, status working/);
});

test("a preview tab left open gets one reminder before the reply", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  await startTurn(f);
  await f.emit("tool_result", { toolName: "mcp__t3-code__preview_open", toolCallId: "c1", isError: false, input: { url: "http://localhost:5173" }, content: [{ type: "text", text: "{\"tabId\":\"tab-9\"}" }] });
  assert.ok(f.active().includes("mcp__t3-code__t3_preview_close"), "the close tool is declared while a tab is open");
  const first = await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
  assert.equal(first.continue, true);
  assert.equal(first.entries[0].customType, ENTRY_TYPE);
  assert.equal(first.entries[1].customType, REMINDER_TYPE);
  assert.match(first.entries[1].content, /tab `tab-9`/);
  assert.equal(await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }), undefined);

  // A tab closed in the same turn needs no reminder, and its close tool is withdrawn.
  await startTurn(f);
  await f.emit("tool_result", { toolName: "mcp__t3-code__t3_preview_close", toolCallId: "c2", isError: false, input: { tabId: "tab-9" }, content: [{ type: "text", text: "{}" }] });
  assert.ok(!f.active().includes("mcp__t3-code__t3_preview_close"));
  const settled = await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
  assert.equal(settled.continue, undefined);
});

test("/t3-agent loadout changes this session's tools and survives a restart", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  const command = f.commands.get("t3-agent");
  await command.handler("loadout lean", f.ctx);
  assert.deepEqual(f.active(), ["read", "bash", "edit", "write", "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__delegate_task", "mcp__t3-code__task_status"]);
  assert.deepEqual(f.appended.at(-1), [LOADOUT_ENTRY, { loadout: "lean" }]);
  await command.handler("loadout huge", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Usage: \/t3-agent loadout lean\|standard\|full/);
  await command.handler("", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Loadout: lean \(set for this session\)/);

  const restarted = fixture(T3, { branch: [{ type: "custom", customType: LOADOUT_ENTRY, data: { loadout: "full" } }] });
  await restarted.emit("session_start", { reason: "resume" });
  assert.equal(restarted.active().filter(name => name.startsWith("mcp__t3-code__")).length, T3_TOOLS.length);
  assert.match((await startTurn(restarted)).t3_agent!, /Declared T3 tools beyond the bridge's: `task_cancel`/);
});

test("/t3-agent forget closes ledger entries without touching T3", async () => {
  const f = fixture(T3, { branch: [{ type: "custom", customType: ENTRY_TYPE, data: { kind: "pr", id: "o/r#1", status: "watching", open: true } }] });
  await f.emit("session_start", { reason: "startup" });
  const command = f.commands.get("t3-agent");
  await command.handler("ledger", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /watching PR o\/r#1/);
  await command.handler("forget o/r#1", f.ctx);
  assert.deepEqual(f.appended.at(-1), [ENTRY_TYPE, { kind: "pr", id: "o/r#1", open: false }]);
  await command.handler("forget o/r#1", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Nothing open matched/);
});

test("the loadout is restored after another extension resets the active tools", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  f.reset(["read", "bash"]);
  await f.emit("model_select");
  assert.deepEqual(f.active(), ["read", "bash", ...["task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task"].map(name => `mcp__t3-code__${name}`)]);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import t3Agent, { LOADOUT_ENTRY, REMINDER_TYPE, STATUS_KEY } from "../extensions/t3-agent/src/index.ts";
import { ENTRY_TYPE } from "../extensions/t3-agent/src/ledger.ts";

// Never read the developer's own t3-agent.json.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "t3-agent-home-"));

const T3 = { T3_MCP_URL: "http://t3.invalid/mcp" };
const T3_TOOLS = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel", "t3_thread_read", "request_secret",
  "html_preview", "html_render", "watch_pull_request", "schedule_task", "t3_preview_close", "preview_open"];

type Handler = (event: any, ctx: any) => any;

function fixture(env: Record<string, string | undefined>, options: { branch?: unknown[]; sessionId?: string; parentSession?: string; active?: string[]; t3Tools?: string[]; direct?: Set<string>; excluded?: Set<string> } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const appended: unknown[][] = [];
  const branch = options.branch ?? [];
  const direct = options.direct ?? new Set(T3_TOOLS.slice(0, 3));
  const statuses: unknown[][] = [];
  const messages: { content: string }[] = [];
  const notices: unknown[][] = [];
  let active = options.active ?? ["read", "bash", "edit", "write", "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__delegate_task", "mcp__t3-code__task_status"];
  const calls: string[] = [];
  const pi = new Proxy({
    on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    getAllTools: () => [
      ...(options.t3Tools ?? T3_TOOLS).map(name => ({ name: `mcp__t3-code__${name}`, exposure: direct.has(name) ? "direct" : "deferred" })),
      ...["read", "bash", "edit", "write", "grep", "find", "ls"].map(name => ({ name, exposure: "direct", sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
    ],
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names.filter(name => !options.excluded?.has(name)); },
    appendEntry: (customType: string, data: unknown) => {
      appended.push([customType, data]);
      branch.push({ type: "custom", customType, data });
    },
    sendMessage: (message: { content: string }) => messages.push(message),
    exec: async () => ({ stdout: "", stderr: "", code: 128, killed: false, truncated: false }),
  }, {
    get(target, key: string) {
      calls.push(key);
      return (target as Record<string, unknown>)[key] ?? (() => { throw new Error(`unexpected pi.${key}`); });
    },
  }) as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    isProjectTrusted: () => false,
    model: { api: "openai-responses" },
    sessionManager: { getBranch: () => branch, getSessionId: () => options.sessionId ?? "pi-session", getHeader: () => ({ parentSession: options.parentSession }) },
    ui: { setStatus: (...args: unknown[]) => statuses.push(args), notify: (...args: unknown[]) => notices.push(args) },
  };
  t3Agent(pi, env);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result as any;
  };
  return { handlers, commands, appended, statuses, notices, messages, calls, ctx, emit, active: () => active, reset: (names: string[]) => { active = [...names]; } };
}

const startTurn = async (f: ReturnType<typeof fixture>) => {
  const sections: Record<string, string> = {};
  await f.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: { sections } });
  return sections;
};

const toolResult = (f: ReturnType<typeof fixture>, name: string, input: Record<string, unknown>, result: Record<string, unknown>) =>
  f.emit("tool_result", { toolName: `mcp__t3-code__${name}`, input, isError: false, content: [], structuredContent: { content: [], structuredContent: result } });

test("the ledger persists only bounded handle data, never URL credentials, prompts or arbitrary links", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  const webhook = "https://example.invalid/hooks/PRIVATE";
  await toolResult(f, "schedule_task", { prompt: "PRIVATE instructions" }, { scheduledTaskId: "s", webhookUrl: webhook });
  await toolResult(f, "preview_open", { url: webhook }, { tabId: "p", url: "https://user:PRIVATE@host/path?PRIVATE#PRIVATE" });
  await toolResult(f, "delegate_task", { title: `Deployment ${webhook}`, task: "PRIVATE instructions" }, { taskId: "d", model: "PRIVATE model", status: webhook, link: webhook });
  await toolResult(f, "t3_thread_send", { message: "PRIVATE child brief" }, { taskId: "d2" });
  await toolResult(f, "watch_pull_request", {}, { url: "https://user:PRIVATE@github.com/o/r/pull/7?PRIVATE#PRIVATE", watching: true });
  await toolResult(f, "watch_pull_request", {}, { url: webhook, watching: true });
  // A terminal pull/number alone does not make an arbitrary URL a canonical PR link.
  await toolResult(f, "watch_pull_request", {}, { url: "https://example.invalid/hooks/PRIVATE/redirect/pull/7", watching: true });
  await toolResult(f, "t3_thread_launch", { title: "Build `nightly`\nPRIVATE" }, { threadId: "t", link: "[PRIVATE](t3-thread://v2/e/t?PRIVATE#PRIVATE)" });
  await toolResult(f, "t3_thread_launch", { title: "a".repeat(1000) }, { threadId: "t2" });
  await toolResult(f, "t3_thread_launch", {}, { threadId: "x".repeat(1000) });
  const { entries } = await f.emit("turn_end", { entries: [] });
  const data = entries.map((e: any) => e.data);
  const prompt = (await startTurn(f)).t3_agent!;
  for (const receipt of [JSON.stringify(data), prompt]) {
    assert.doesNotMatch(receipt, /PRIVATE|hooks\/|user:|detail|`nightly`|[ax]{256}/);
    assert.match(receipt, /https:\/\/github\.com\/o\/r\/pull\/7/);
    assert.match(receipt, /<t3-thread:\/\/v2\/e\/t>/);
  }
});

test("old branch entries pass the same privacy and type checks when replayed", async () => {
  const data = [
    { kind: "schedule", id: "s", open: true, detail: "webhook https://example.invalid/PRIVATE" },
    { kind: "preview", id: "p", open: true, detail: "https://u:PRIVATE@example.invalid/#PRIVATE" },
    { kind: "delegate", id: "d", open: true, status: "PRIVATE detail", link: "https://example.invalid/PRIVATE", title: "Go to https://example.invalid/PRIVATE" },
    { kind: "pr", id: "https://u:PRIVATE@github.com/o/r/pull/7?PRIVATE#PRIVATE", open: true },
    { kind: "thread", id: "t", link: "<t3-thread://v2/e/t?PRIVATE#PRIVATE>", open: true },
    { kind: "thread", id: "https://example.invalid/PRIVATE", open: true },
    { kind: "thread", id: "t-bad", open: "PRIVATE" },
    { kind: "PRIVATETYPE", id: "t", open: true },
  ];
  const f = fixture(T3, { branch: data.map(data => ({ type: "custom", customType: ENTRY_TYPE, data })) });
  await f.emit("session_start");
  await f.commands.get("t3-agent").handler("ledger", f.ctx);
  for (const receipt of [String(f.notices.at(-1)![0]), (await startTurn(f)).t3_agent!]) {
    assert.doesNotMatch(receipt, /PRIVATE|t-bad/);
    assert.match(receipt, /scheduledTaskId=s/);
    assert.match(receipt, /https:\/\/github\.com\/o\/r\/pull\/7/);
    assert.match(receipt, /<t3-thread:\/\/v2\/e\/t>/);
  }
});

test("foreign PR watches cannot close this thread's watch, and a Pi fork does not inherit it", async () => {
  const session = SessionManager.inMemory();
  const f = fixture(T3, { sessionId: session.getSessionId() });
  await f.emit("session_start");
  await toolResult(f, "orchestrator_capabilities", {}, { parentThreadId: "thread:here", runtimeMode: "auto", providers: [] });
  await toolResult(f, "t3_environment_links", {}, { environmentId: "env-here", links: [], notListed: "" });
  const pr = { host: "github.com", repository: "o/r", number: 7, url: "https://github.com/o/r/pull/7", watching: true, wasWatching: false };
  await toolResult(f, "watch_pull_request", { url: pr.url }, pr);
  for (const input of [{ threadId: "elsewhere" }, { threadId: "thread:here", environmentId: "env-remote" }]) {
    await toolResult(f, "unwatch_pull_request", { url: pr.url, ...input }, { ...pr, watching: false, wasWatching: true });
  }
  assert.match((await startTurn(f)).t3_agent!, /watching PR .*\/pull\/7/);
  const { entries } = await f.emit("turn_end", { entries: [] });
  assert.deepEqual(entries.map((e: any) => e.data.target), [undefined, { threadId: "elsewhere" }, { environmentId: "env-remote", threadId: "thread:here" }]);
  for (const { data } of entries) assert.deepEqual(data.scope, { sessionId: session.getSessionId(), threadId: "thread:here", environmentId: "env-here" });
  for (const entry of entries) session.appendCustomEntry(entry.customType, entry.data);
  const resumed = fixture(T3, { sessionId: session.getSessionId(), branch: session.getBranch() });
  await resumed.emit("session_start");
  await toolResult(resumed, "t3_thread_list", {}, { currentThreadId: "thread:here", threads: [], nextCursor: null, total: 0 });
  await toolResult(resumed, "t3_environment_read", {}, { environmentId: "env-remote", label: "Other", preferences: {} });
  assert.doesNotMatch((await startTurn(resumed)).t3_agent!, /watching PR/);
  await toolResult(resumed, "t3_environment_read", {}, { environmentId: "env-here", label: "Local", preferences: {} });
  assert.match((await startTurn(resumed)).t3_agent!, /watching PR/);
  session.appendCustomEntry(ENTRY_TYPE, { kind: "preview", id: "legacy-tab", open: true });
  session.createBranchedSession(session.getLeafId()!);
  const fork = fixture(T3, { branch: session.getBranch(), sessionId: session.getSessionId(), parentSession: "/parent.jsonl" });
  await fork.emit("session_start", { reason: "fork", previousSessionFile: "/parent.jsonl" });
  assert.doesNotMatch((await startTurn(fork)).t3_agent!, /watching PR|legacy-tab/);
});

test("same schedule id on a linked environment is retained but never treated as the local schedule", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  const here = { scheduledTaskId: "s", enabled: true, projectId: "project", boundThreadId: null };
  await toolResult(f, "schedule_task", { prompt: "deploy", title: "Here" }, here);
  await toolResult(f, "schedule_task", { environmentId: "linked", prompt: "deploy", title: "There" }, { ...here, enabled: false });
  const branch = (await f.emit("turn_end", { entries: [] })).entries;
  const restart = fixture(T3, { branch });
  await restart.emit("session_start");
  const listing = async () => {
    await restart.commands.get("t3-agent").handler("ledger", restart.ctx);
    return String(restart.notices.at(-1)![0]);
  };
  const both = await listing();
  assert.match(both, /Here.*status enabled/);
  assert.match(both, /There.*status paused.*env=linked\/s/);
  assert.doesNotMatch((await startTurn(restart)).t3_agent!, /There/);
  await restart.commands.get("t3-agent").handler("forget env=linked/s", restart.ctx);
  assert.match(await listing(), /Here/);
  assert.doesNotMatch(await listing(), /There/);
});

test("requested PR and schedule lists reconcile recorded observations, not unrelated or filtered-out IDs", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  const pr = { host: "gitlab.example", repository: "team/p", number: 4, url: "https://gitlab.example/team/p/-/merge_requests/4" };
  await toolResult(f, "watch_pull_request", { url: pr.url }, { ...pr, watching: true, wasWatching: false });
  await toolResult(f, "schedule_task", { prompt: "Check" }, { scheduledTaskId: "s", projectId: "p", boundThreadId: null, enabled: true });
  const empty = { pullRequests: [], chains: [], nextCursor: null };
  await toolResult(f, "list_thread_pull_requests", { states: ["closed"] }, empty);
  await toolResult(f, "list_thread_pull_requests", {}, { ...empty, nextCursor: "page2" });
  await toolResult(f, "list_thread_pull_requests", { environmentId: "remote" }, empty);
  await toolResult(f, "list_scheduled_tasks", { scheduledTaskId: "s", projectId: "other" }, { tasks: [] });
  const partial = (await startTurn(f)).t3_agent!;
  assert.match(partial, /watching PR team\/p#4@gitlab\.example/);
  assert.match(partial, /scheduledTaskId=s, status enabled/);
  await toolResult(f, "list_thread_pull_requests", {}, { ...empty, pullRequests: [{ ...pr, state: "open", watching: false, source: "manual", stack: null }] });
  await toolResult(f, "list_scheduled_tasks", { scheduledTaskId: "s" }, { tasks: [{ scheduledTaskId: "s", enabled: false, prompt: "PRIVATE" }] });
  const checked = (await startTurn(f)).t3_agent!;
  assert.doesNotMatch(checked, /watching PR|PRIVATE/);
  assert.match(checked, /scheduledTaskId=s, status paused/);
});

test("rewinding replays a tab observation, not T3 undo; a requested complete tab list reconciles it", async () => {
  const branch: unknown[] = [];
  const f = fixture(T3, { branch });
  await f.emit("session_start");
  await toolResult(f, "preview_open", { reuseExistingTab: false }, { tabId: "gone", available: true, control: { owner: "agent", ownedByCaller: true } });
  branch.push(...(await f.emit("turn_end", { entries: [] })).entries);
  const beforeClose = branch.length;
  await toolResult(f, "t3_preview_close", { tabId: "gone" }, {});
  branch.push(...(await f.emit("turn_end", { entries: [] })).entries);
  branch.splice(beforeClose);
  await f.emit("session_tree", { oldLeafId: "close", newLeafId: "open" });
  assert.match((await startTurn(f)).t3_agent!, /tabId=gone/);
  const list = { sessions: [], serverEpoch: "server-1", revision: 10, nextCursor: null };
  await toolResult(f, "t3_preview_list", { cursor: 3 }, list);
  assert.match((await startTurn(f)).t3_agent!, /tabId=gone/, "one page is not a full observation");
  await toolResult(f, "t3_preview_list", {}, list);
  assert.doesNotMatch((await startTurn(f)).t3_agent!, /tabId=gone/);
  branch.push(...(await f.emit("turn_end", { entries: [] })).entries);
  const restart = fixture(T3, { branch });
  await restart.emit("session_start");
  assert.doesNotMatch((await startTurn(restart)).t3_agent!, /tabId=gone/);
});

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
  assert.match(sections.t3_agent!, /Active T3 tools: 10\b/);
});

test("headless T3 sessions never call ctx.ui, including for command feedback or config warnings", async t => {
  const f = fixture(T3);
  f.ctx.hasUI = false;
  f.ctx.cwd = mkdtempSync(join(tmpdir(), "t3-agent-headless-"));
  t.after(() => rmSync(f.ctx.cwd, { recursive: true, force: true }));
  f.ctx.isProjectTrusted = () => true;
  mkdirSync(join(f.ctx.cwd, ".pi"));
  writeFileSync(join(f.ctx.cwd, ".pi", "t3-agent.json"), '{"loadout":"invalid"}');
  await f.emit("session_start");
  await startTurn(f);
  await toolResult(f, "schedule_task", {}, { scheduledTaskId: "s" });
  for (const command of ["status", "ledger", "loadout lean", "loadout bogus", "forget s", "forget missing", "unknown"]) {
    await f.commands.get("t3-agent").handler(command, f.ctx);
  }
  await f.emit("agent_settled");
  assert.deepEqual([f.statuses, f.notices], [[], []]);
  assert.match(f.messages[0]!.content, /Configuration problems:/);
  f.ctx.hasUI = true;
  await startTurn(f);
  assert.equal(f.notices.length, 1, "an unsent config warning was not marked delivered");
});

test("/t3-agent status separates unavailable tool names from invalid config and checks the live catalog", async t => {
  const t3Tools = [...T3_TOOLS];
  const f = fixture(T3, { t3Tools });
  f.ctx.cwd = mkdtempSync(join(tmpdir(), "t3-agent-catalog-"));
  t.after(() => rmSync(f.ctx.cwd, { recursive: true, force: true }));
  f.ctx.isProjectTrusted = () => true;
  mkdirSync(join(f.ctx.cwd, ".pi"));
  writeFileSync(join(f.ctx.cwd, ".pi", "t3-agent.json"), JSON.stringify({ tools: ["preview_open", "missing_tool", "Bad Name"] }));
  await f.emit("session_start");
  const status = async () => {
    await f.commands.get("t3-agent").handler("status", f.ctx);
    return String(f.notices.at(-1)![0]);
  };
  const report = await status();
  assert.match(report, /^Configured tools not in the current catalog: missing_tool\.$/m);
  assert.match(report, /Configuration problems:\n.*invalid tool name/i);
  assert.ok(f.active().includes("mcp__t3-code__preview_open"));
  t3Tools.push("missing_tool");
  assert.doesNotMatch(await status(), /not in the current catalog/);
});

test("composer status updates only when its displayed text changes", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  await f.emit("session_tree");
  await toolResult(f, "t3_thread_launch", {}, { threadId: "t" });
  await f.emit("agent_settled");
  await toolResult(f, "delegate_task", {}, { taskId: "d", status: "running" });
  await toolResult(f, "task_status", { taskId: "d" }, { status: "running", workState: "working" });
  await toolResult(f, "task_cancel", { taskId: "d" }, { status: "cancelled" });
  await f.emit("agent_settled");
  assert.deepEqual(f.statuses, [
    [STATUS_KEY, "t3-agent: full access · standard loadout"],
    [STATUS_KEY, "t3-agent: full access · standard loadout · 1 delegate"],
    [STATUS_KEY, "t3-agent: full access · standard loadout"],
  ]);
});

test("supervised threads get Pi's read-only search tools", async () => {
  const f = fixture({ ...T3, T3_PI_RUNTIME_MODE: "approval-required" });
  await f.emit("session_start", { reason: "startup" });
  for (const name of ["grep", "find", "ls"]) assert.ok(f.active().includes(name), name);
  assert.match((await startTurn(f)).t3_agent!, /`read`, `grep`, `find`, `ls`, the built-in `tool_search` and the bridge's read-only T3 tools/);
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
    toolName: "mcp__t3-code__delegate_task", toolCallId: "c1", isError: false, input: { title: "Review the branch", task: "Check the patch" },
    content: [{ type: "text", text: JSON.stringify({ taskId: "node:task-1", status: "running", workState: "working", link: "<t3-thread://v2/e/t1>" }) }],
  });
  await f.emit("tool_result", { toolName: "mcp__t3-code__html_render", toolCallId: "c2", isError: true, input: {}, content: [{ type: "text", text: "{\"taskId\":\"x\"}" }] });
  assert.deepEqual(f.statuses.at(-1), [STATUS_KEY, "t3-agent: full access · standard loadout · 1 delegate"]);
  const boundary = await f.emit("turn_end", { entries: [], continue: false });
  assert.deepEqual(boundary.entries, [{ type: "custom", customType: ENTRY_TYPE, data: { version: 1, scope: { sessionId: "pi-session" }, kind: "delegate", id: "node:task-1", open: true, explicitTitle: "Review the branch", link: "<t3-thread://v2/e/t1>", status: "working" } }]);
  assert.equal(await f.emit("turn_end", { entries: [], continue: false }), undefined);
  assert.match((await startTurn(f)).t3_agent!, /### Open T3 handles[\s\S]*delegate "Review the branch" taskId=node:task-1, status working/);
});

test("reused, human-owned, ambiguous and unavailable preview tabs do not trigger a close reminder", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  const owned = { owner: "agent", ownedByCaller: true };
  const human = { owner: "human", ownedByCaller: false };
  for (const [input, result] of [
    [{ tabId: "existing" }, { tabId: "existing", control: owned }],
    [{}, { tabId: "ambiguous", control: owned }],
    [{ reuseExistingTab: false }, { tabId: "reused", reused: true, control: owned }],
    [{ reuseExistingTab: false }, { tabId: "human", control: human }],
    [{ reuseExistingTab: false }, { tabId: "unknown" }],
    [{ tabId: "missing" }, { available: false, tabId: null }],
  ] as const) await toolResult(f, "preview_open", input, result);
  const settled = await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
  assert.ok(!settled?.continue);
  assert.ok(!settled?.entries.some((entry: any) => entry.customType === REMINDER_TYPE));
  assert.doesNotMatch((await startTurn(f)).t3_agent!, /tabId=missing|opened by you/);

  // A later observation that the user took over revokes an earlier ownership observation.
  await toolResult(f, "preview_open", { reuseExistingTab: false }, { tabId: "new", control: owned });
  await toolResult(f, "preview_status", {}, { tabId: "new", control: human });
  assert.ok(!(await f.emit("agent_before_settle", { entries: [], outcome: "completed" }))?.continue);

  // Server preview status also reports ownership of other tabs in the thread.
  await toolResult(f, "preview_open", { reuseExistingTab: false }, { tabId: "other", control: owned });
  await toolResult(f, "preview_status", {}, { tabId: "current", tabs: [{ tabId: "other", ...human }] });
  assert.ok(!(await f.emit("agent_before_settle", { entries: [], outcome: "completed" }))?.continue);
});

test("a new caller-owned preview tab left open gets one automated reminder before the reply", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  await startTurn(f);
  await toolResult(f, "preview_open", { reuseExistingTab: false }, { tabId: "tab-9", control: { owner: "agent", ownedByCaller: true } });
  assert.ok(f.active().includes("mcp__t3-code__t3_preview_close"), "the close tool is declared while a tab is open");
  await toolResult(f, "preview_open", { tabId: "tab-9" }, { tabId: "tab-9", control: { owner: "agent", ownedByCaller: true } });
  const first = await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
  assert.equal(first.continue, true);
  assert.equal(first.entries[0].customType, ENTRY_TYPE);
  assert.equal(first.entries.at(-1).customType, REMINDER_TYPE);
  assert.match(first.entries.at(-1).content, /automated note from the t3-agent extension, not from the user/i);
  assert.match(first.entries.at(-1).content, /tab `tab-9`/);
  assert.equal(await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }), undefined);

  // A tab closed in the same turn needs no reminder, and its close tool is withdrawn.
  await startTurn(f);
  await f.emit("tool_result", { toolName: "mcp__t3-code__t3_preview_close", toolCallId: "c2", isError: false, input: { tabId: "tab-9" }, content: [{ type: "text", text: "{}" }] });
  assert.ok(!f.active().includes("mcp__t3-code__t3_preview_close"));
  const settled = await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" });
  assert.equal(settled.continue, undefined);
});

test("the ledger command lists every handle, including threads omitted by the bounded prompt", async () => {
  const data = [
    ...Array.from({ length: 27 }, (_, i) => ({ kind: "delegate", id: `d-${i}`, open: true })),
    ...Array.from({ length: 8 }, (_, i) => ({ kind: "thread", id: `t-${i}`, open: true })),
  ];
  const f = fixture(T3, { branch: data.map(data => ({ type: "custom", customType: ENTRY_TYPE, data })) });
  await f.emit("session_start");
  await f.commands.get("t3-agent").handler("ledger", f.ctx);
  const listing = f.notices.map(([message]) => message).join("\n");
  for (const { id } of data) assert.match(listing, new RegExp(`\\b${id}\\b`));
  assert.doesNotMatch(listing, /run \/t3-agent ledger/);
  assert.match((await startTurn(f)).t3_agent!, /11 more; run \/t3-agent ledger/);

  const threads = fixture(T3, { branch: data.slice(27).map(data => ({ type: "custom", customType: ENTRY_TYPE, data })) });
  await threads.emit("session_start");
  const section = (await startTurn(threads)).t3_agent!;
  assert.match(section, /3 more; run \/t3-agent ledger/);
  assert.doesNotMatch(section, /thread t-2\b/);
  assert.match(section, /thread t-7\b/);
});

test("both boundaries append to earlier entries and preserve an earlier continuation", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  const earlier = { type: "custom", customType: "another-extension" };
  for (const boundary of ["turn_end", "agent_before_settle"]) {
    await toolResult(f, "schedule_task", {}, { scheduledTaskId: "s", enabled: false });
    const prior = { entries: [earlier], continue: true, outcome: "completed" };
    // Pi replaces only the fields supplied by the handler.
    const proposal = { ...prior, ...await f.emit(boundary, prior) };
    assert.deepEqual(proposal.entries.map((e: any) => e.customType), [earlier.customType, ENTRY_TYPE]);
    assert.equal(proposal.continue, true);
  }
  await toolResult(f, "preview_open", { reuseExistingTab: false }, { tabId: "p", control: { ownedByCaller: true } });
  const reminder = await f.emit("agent_before_settle", { entries: [earlier], continue: true, outcome: "completed" });
  assert.deepEqual(reminder.entries.map((e: any) => e.customType), [earlier.customType, ENTRY_TYPE, REMINDER_TYPE]);
  assert.equal(reminder.continue, true);
});

test("/t3-agent loadout changes this session's tools and survives a restart", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  const command = f.commands.get("t3-agent");
  await command.handler("loadout lean", f.ctx);
  assert.deepEqual(f.active(), ["read", "bash", "edit", "write", "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__delegate_task", "mcp__t3-code__task_status"]);
  assert.deepEqual(f.appended.findLast(([type]) => type === LOADOUT_ENTRY), [LOADOUT_ENTRY, { loadout: "lean" }]);
  await command.handler("loadout huge", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Usage: \/t3-agent loadout lean\|standard\|full/);
  await command.handler("", f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Loadout: lean \(set for this session\)/);

  const restarted = fixture(T3, { branch: [{ type: "custom", customType: LOADOUT_ENTRY, data: { loadout: "full" } }] });
  await restarted.emit("session_start", { reason: "resume" });
  assert.equal(restarted.active().filter(name => name.startsWith("mcp__t3-code__")).length, T3_TOOLS.length);
  assert.match((await startTurn(restarted)).t3_agent!, /Active T3 tools: 12\b/);
});

test("/t3-agent forget closes ledger entries without touching T3", async () => {
  const id = "https://github.com/o/r/pull/1";
  const f = fixture(T3, { branch: [{ type: "custom", customType: ENTRY_TYPE, data: { kind: "pr", id, status: "watching", open: true } }] });
  await f.emit("session_start", { reason: "startup" });
  const command = f.commands.get("t3-agent");
  await command.handler("ledger", f.ctx);
  assert.ok(String(f.notices.at(-1)![0]).includes(`watching PR ${id}`));
  await command.handler(`forget ${id}`, f.ctx);
  assert.deepEqual(f.appended.at(-1), [ENTRY_TYPE, { version: 1, scope: { sessionId: "pi-session" }, kind: "pr", id, open: false }]);
  await command.handler(`forget ${id}`, f.ctx);
  assert.match(String(f.notices.at(-1)![0]), /Nothing open matched/);
});

test("forget before turn_end stays forgotten on replay", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  await toolResult(f, "schedule_task", { prompt: "Check" }, { scheduledTaskId: "s", enabled: true });
  await f.commands.get("t3-agent").handler("forget s", f.ctx);
  const boundary = await f.emit("turn_end", { entries: [] });
  const restart = fixture(T3, { branch: [...f.ctx.sessionManager.getBranch(), ...boundary?.entries ?? []] });
  await restart.emit("session_start");
  await restart.commands.get("t3-agent").handler("ledger", restart.ctx);
  assert.match(String(restart.notices.at(-1)![0]), /No open T3 handles/);
});

test("device_close with T3's empty result closes every and only matching host/id pair on replay", async () => {
  const f = fixture(T3);
  await f.emit("session_start");
  for (const [hostId, id] of [["local", "A"], ["local", "B"], ["remote", "A"], ["remote", "C"]]) {
    await toolResult(f, "device_open", { deviceId: id, hostId }, { device: { id, hostId } });
  }
  const branch = f.ctx.sessionManager.getBranch();
  async function close(input: Record<string, string>) {
    await toolResult(f, "device_close", input, {});
    const boundary = await f.emit("turn_end", { entries: [] });
    branch.push(...boundary?.entries ?? []);
    const restart = fixture(T3, { branch });
    await restart.emit("session_start");
    await restart.commands.get("t3-agent").handler("ledger", restart.ctx);
    return String(restart.notices.at(-1)![0]);
  }
  assert.equal(await close({ deviceId: "A" }), "- device deviceId=B on hostId=local\n- device deviceId=C on hostId=remote");
  assert.equal(await close({ hostId: "local" }), "- device deviceId=C on hostId=remote");
  assert.match(await close({}), /No open T3 handles/);
});

test("forget can address a device by host/id and its close survives replay", async () => {
  const branch = ["one", "two"].map(hostId => ({ type: "custom", customType: ENTRY_TYPE, data: { kind: "device", id: "sim", hostId, open: true } }));
  const f = fixture(T3, { branch });
  await f.emit("session_start");
  await f.commands.get("t3-agent").handler("forget one/sim", f.ctx);
  const closed = f.appended.find(([type]) => type === ENTRY_TYPE);
  assert.ok(closed);
  const restart = fixture(T3, { branch: [...branch, { type: "custom", customType: closed[0], data: closed[1] }] });
  await restart.emit("session_start");
  const prompt = (await startTurn(restart)).t3_agent!;
  assert.match(prompt, /deviceId=sim.*hostId=two/);
  assert.doesNotMatch(prompt, /hostId=one/);
});

test("a restarted loadout withdraws exactly this branch’s recorded additions", async () => {
  const prefix = "mcp__t3-code__";
  const baseline = ["read", "bash", ...T3_TOOLS.slice(0, 3).map(name => prefix + name), prefix + "html_render"];
  const first = fixture(T3, { active: baseline });
  await first.emit("session_start");
  await toolResult(first, "preview_open", { reuseExistingTab: false }, { tabId: "new", control: { ownedByCaller: true } });
  const branch = [...first.ctx.sessionManager.getBranch(), ...(await first.emit("turn_end", { entries: [] })).entries];
  const restart = fixture(T3, { branch, active: first.active() });
  await restart.emit("session_start");
  await restart.commands.get("t3-agent").handler("loadout lean", restart.ctx);
  await toolResult(restart, "t3_preview_close", { tabId: "new" }, {});
  assert.deepEqual(restart.active(), baseline);
});

test("an addition Pi refused does not confer ownership if another extension later activates it", async () => {
  const tool = "mcp__t3-code__html_preview";
  const excluded = new Set([tool]);
  const f = fixture(T3, { excluded });
  await f.emit("session_start");
  excluded.clear();
  f.reset([...f.active(), tool]);
  await f.commands.get("t3-agent").handler("loadout lean", f.ctx);
  assert.ok(f.active().includes(tool));
});

test("tree navigation does not use ownership from the branch just left", async () => {
  const branch: unknown[] = [];
  const f = fixture(T3, { branch });
  await f.emit("session_start");
  const restoredActive = ["read", "mcp__t3-code__html_preview"];
  f.reset(restoredActive);
  branch.splice(0, branch.length, { type: "custom", customType: LOADOUT_ENTRY, data: { loadout: "lean" } });
  await f.emit("session_tree");
  assert.deepEqual(f.active(), restoredActive);
});

test("switching to lean cannot withdraw tools now required by the bridge", async () => {
  const required = T3_TOOLS.map(name => "mcp__t3-code__" + name);
  for (const api of ["openai-completions", "openai-responses"]) {
    const direct = new Set(T3_TOOLS.slice(0, 3));
    const f = fixture(T3, { direct });
    await f.emit("session_start");
    f.ctx.model.api = api;
    // With no built-in search the bridge re-registers its optional tools direct.
    if (api === "openai-responses") for (const name of T3_TOOLS) direct.add(name);
    f.reset(["read", ...required]);
    await f.emit("model_select");
    await f.commands.get("t3-agent").handler("loadout lean", f.ctx);
    assert.deepEqual(f.active(), ["read", ...required], api);
  }
});

test("codemode-only reports T3 tools as active even though none are declared", async () => {
  const { createCodemodeToolDefinition } = await import(new URL("./extensions/codemode/tool.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const names = T3_TOOLS.slice(0, 3);
  const tools = names.map(n => ({ name: "mcp__t3-code__" + n, description: n, parameters: { type: "object", properties: {} } }));
  const { hiddenDeclarations } = createCodemodeToolDefinition({ getMode: () => "only" }).prepareLoadout({
    declared: tools, callable: tools, getExposure: () => "direct", getNamespace: () => undefined, getPromptGuidelines: () => [],
  });
  assert.deepEqual(hiddenDeclarations, tools.map(tool => tool.name));
  const f = fixture(T3, { t3Tools: names, active: ["codemode", ...hiddenDeclarations] });
  await f.emit("session_start");
  const sections: Record<string, string> = {};
  await f.emit("before_agent_start", { systemPromptOptions: { sections, hiddenTools: hiddenDeclarations } });
  await f.commands.get("t3-agent").handler("status", f.ctx);
  for (const report of [sections.t3_agent!, String(f.notices.at(-1)![0])]) assert.match(report, /Active T3 tools: 3\b/);
});

test("the prompt and status report actual active T3 counts for a partial or empty catalog", async () => {
  for (const count of [20, 0]) {
    const t3Tools = count ? Array.from({ length: 31 }, (_, i) => "tool_" + i) : [];
    const f = fixture(T3, { t3Tools, active: ["read", ...t3Tools.slice(0, count).map(name => "mcp__t3-code__" + name)] });
    await f.emit("session_start");
    await f.commands.get("t3-agent").handler("status", f.ctx);
    for (const report of [(await startTurn(f)).t3_agent!, String(f.notices.at(-1)![0])]) {
      assert.match(report, new RegExp(`Active T3 tools: ${count}\\b`));
      assert.doesNotMatch(report, /every T3 tool is declared|bridge's three/i);
    }
  }
});

test("the loadout is restored after another extension resets the active tools", async () => {
  const f = fixture(T3);
  await f.emit("session_start", { reason: "startup" });
  f.reset(["read", "bash"]);
  await f.emit("model_select");
  assert.deepEqual(f.active(), ["read", "bash", ...["task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task"].map(name => `mcp__t3-code__${name}`)]);
});

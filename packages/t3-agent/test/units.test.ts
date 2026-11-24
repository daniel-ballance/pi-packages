import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig, readConfig } from "../extensions/t3-agent/src/config.ts";
import { Ledger, observe, rebuild, resultPayload, ENTRY_TYPE } from "../extensions/t3-agent/src/ledger.ts";
import { contextualTools, desiredTools, nextActive, type ToolInfo } from "../extensions/t3-agent/src/loadout.ts";
import { buildSection } from "../extensions/t3-agent/src/prompt.ts";
import { modeLabel, runtimeMode, t3ToolName } from "../extensions/t3-agent/src/runtime.ts";
import { readWorkspace, type Exec } from "../extensions/t3-agent/src/workspace.ts";

// Recorded from real T3 sessions: results arrive as JSON text with no structured content.
const delegateResult = [{ type: "text", text: JSON.stringify({
  taskId: "node:delegated-task:abc", link: "<t3-thread://v2/env/thread:delegated-task:abc>", status: "running", workState: "working",
  model: "openai-codex/gpt-6.1-sol", next: "Completion wakes this thread, so end your turn.",
}) }];

test("runtime facts mirror the bridge", () => {
  assert.equal(t3ToolName("mcp__t3-code__delegate_task"), "delegate_task");
  assert.equal(t3ToolName("mcp__t3_code__task_status"), "task_status");
  assert.equal(t3ToolName("mcp__context7__query_docs"), undefined);
  assert.equal(runtimeMode({}), "full-access");
  assert.equal(runtimeMode({ T3_PI_RUNTIME_MODE: "bogus" }), "full-access");
  assert.equal(runtimeMode({ T3_PI_RUNTIME_MODE: "approval-required" }), "approval-required");
  assert.equal(modeLabel("auto"), "supervised");
  assert.equal(modeLabel("auto-accept-edits"), "auto-accept edits");
});

test("config merges user then trusted project files and reports bad values", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-agent-config-"));
  try {
    const agent = join(dir, "agent"), project = join(dir, "project");
    mkdirSync(agent);
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(agent, "t3-agent.json"), JSON.stringify({ loadout: "full", tools: ["t3_worktree_status"], bogus: 1 }));
    writeFileSync(join(project, ".pi", "t3-agent.json"), JSON.stringify({ loadout: "lean", tools: ["Bad Name"] }));
    const env = { PI_CODING_AGENT_DIR: agent };
    const untrusted = readConfig(project, false, env);
    assert.deepEqual(untrusted.config, { loadout: "full", tools: ["t3_worktree_status"] });
    assert.equal(untrusted.problems.length, 1);
    const trusted = readConfig(project, true, env);
    assert.equal(trusted.config.loadout, "lean");
    assert.deepEqual(trusted.config.tools, ["t3_worktree_status"]);
    assert.equal(trusted.problems.length, 2);
    const problems: string[] = [];
    assert.deepEqual(mergeConfig(DEFAULT_CONFIG, [], "x", problems), DEFAULT_CONFIG);
    assert.match(problems[0]!, /expected a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger records T3 handles from JSON text and closes them", () => {
  const ledger = new Ledger();
  const apply = (tool: string, input: Record<string, unknown>, content: { type: string; text?: string }[]) =>
    observe(tool, input, resultPayload(content)).forEach(update => ledger.apply(update));

  apply("delegate_task", { task: "Review the diff\nin detail", title: "Review the diff" }, delegateResult);
  apply("schedule_task", { title: "nightly", schedule: { type: "interval", everyMs: 1 } }, [{ type: "text", text: JSON.stringify({ scheduledTaskId: "scheduled-task:1", title: "nightly", nextRunAt: "2026-11-24T08:00:00.000Z" }) }]);
  apply("watch_pull_request", { url: "https://github.com/o/r/pull/7" }, [{ type: "text", text: "{}" }]);
  apply("preview_open", { url: "http://localhost:3000" }, [{ type: "text", text: JSON.stringify({ tabId: "tab-1" }) }]);
  apply("t3_thread_launch", { title: "Nightly", message: "go" }, [{ type: "text", text: JSON.stringify({ threadId: "t-1", link: "<t3-thread://v2/e/t-1>" }) }]);
  apply("html_render", { path: "/x.html" }, [{ type: "text", text: "{}" }]);

  const text = ledger.render()!;
  assert.match(text, /delegate "Review the diff" taskId=node:delegated-task:abc, status working link <t3-thread:/);
  assert.match(text, /schedule "nightly" scheduledTaskId=scheduled-task:1, status enabled/);
  assert.match(text, /watching PR https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(text, /preview tab tabId=tab-1/);
  assert.match(text, /thread "Nightly" <t3-thread:\/\/v2\/e\/t-1>/);
  assert.deepEqual(contextualTools(ledger).sort(), ["delete_scheduled_task", "t3_preview_close", "task_cancel", "unwatch_pull_request"]);

  apply("task_status", { taskId: "node:delegated-task:abc" }, [{ type: "text", text: JSON.stringify({ taskId: "node:delegated-task:abc", status: "completed", workState: "result_available", summary: "done" }) }]);
  apply("delete_scheduled_task", { scheduledTaskId: "scheduled-task:1" }, [{ type: "text", text: '{"deleted":true}' }]);
  apply("unwatch_pull_request", { url: "https://github.com/o/r/pull/7" }, [{ type: "text", text: "{}" }]);
  apply("t3_preview_close", { tabId: "tab-1" }, [{ type: "text", text: "{}" }]);
  assert.deepEqual(ledger.open().map(handle => handle.kind), ["thread"]);
  assert.deepEqual(ledger.forget("all"), [{ kind: "thread", id: "t-1", open: false }]);
  assert.equal(ledger.render(), undefined);
});

test("closing a handle discards its details before an id is reused", () => {
  const ledger = new Ledger();
  ledger.apply({ kind: "schedule", id: "s", open: true, title: "Obsolete title" });
  ledger.apply({ kind: "schedule", id: "s", open: false });
  ledger.apply({ kind: "schedule", id: "s", open: true });
  assert.doesNotMatch(ledger.render()!, /Obsolete/);
});

test("a running delegate stays open until its result is read or it is cancelled", () => {
  const ledger = new Ledger();
  observe("delegate_task", { task: "x" }, resultPayload(delegateResult)).forEach(update => ledger.apply(update));
  observe("task_status", { taskId: "node:delegated-task:abc" }, { taskId: "node:delegated-task:abc", status: "running", workState: "waiting_for_children" }).forEach(update => ledger.apply(update));
  assert.equal(ledger.open("delegate")[0]!.status, "waiting_for_children");
  observe("task_cancel", { taskId: "node:delegated-task:abc" }, { status: "completed" }).forEach(update => ledger.apply(update));
  assert.equal(ledger.open("delegate").length, 0);
  // A send to a finished child thread starts a new task; a send to a live thread does not.
  assert.deepEqual(observe("t3_thread_send", { message: "Fix the review findings" }, { threadId: "t", link: "<l>", status: "starting" }), []);
  observe("t3_thread_send", { message: "Fix the review findings" }, { taskId: "node:task-2", link: "<l>", status: "running" }).forEach(update => ledger.apply(update));
  assert.deepEqual(ledger.open("delegate").map(handle => [handle.id, handle.title]), [["node:task-2", undefined]]);
});

test("a cancel receipt preserves the reported task state, including a pending cancel", () => {
  assert.deepEqual(observe("task_cancel", { taskId: "d" }, { status: "cancel_requested" }), [
    { kind: "delegate", id: "d", open: true, status: "cancelling" },
  ]);
  assert.deepEqual(observe("task_cancel", { taskId: "d" }, { status: "completed" }), [
    { kind: "delegate", id: "d", open: false, status: "completed" },
  ]);
  assert.deepEqual(observe("task_cancel", { taskId: "d" }, {}), []);
});

test("a wait that delivered the terminal result leaves no open task", () => {
  const ledger = new Ledger();
  observe("delegate_task", { mode: "wait", task: "check" }, { taskId: "d", status: "completed", workState: "result_available", summary: "done" })
    .forEach(update => ledger.apply(update));
  assert.deepEqual(ledger.open(), []);
});

test("a paused schedule exists until T3 reports deletion", () => {
  const ledger = new Ledger();
  const apply = (tool: string, result: Record<string, unknown>) =>
    observe(tool, { scheduledTaskId: "s" }, { scheduledTaskId: "s", ...result }).forEach(update => ledger.apply(update));
  rebuild(ledger, [{ type: "custom", customType: ENTRY_TYPE, data: { kind: "schedule", id: "legacy", open: false, status: "paused" } }]);
  assert.match(ledger.render() ?? "", /scheduledTaskId=legacy, status paused/);
  ledger.clear();
  apply("schedule_task", { enabled: false });
  assert.match(ledger.render() ?? "", /scheduledTaskId=s, status paused/);
  apply("update_scheduled_task", { enabled: true });
  assert.match(ledger.render() ?? "", /scheduledTaskId=s, status enabled/);
  apply("update_scheduled_task", { enabled: false });
  apply("delete_scheduled_task", { deleted: false });
  assert.match(ledger.render() ?? "", /scheduledTaskId=s, status paused/);
  apply("delete_scheduled_task", { deleted: true });
  assert.deepEqual(ledger.open(), []);
});

test("devices use the reported host and id, including on an argument-less close", () => {
  const ledger = new Ledger();
  const apply = (tool: string, input: Record<string, unknown>, result: Record<string, unknown>) =>
    observe(tool, input, result).forEach(update => ledger.apply(update));
  apply("device_open", { platform: "ios" }, { device: { id: "sim", hostId: "mac-1" } });
  apply("device_open", { hostId: "mac-2", deviceId: "sim" }, {});
  assert.equal(ledger.open("device").length, 2);
  apply("device_close", {}, { device: { id: "sim", hostId: "mac-1" } });
  assert.equal(ledger.open("device").length, 1);
  assert.match(ledger.render()!, /deviceId=sim.*hostId=mac-2/);
  apply("device_close", { hostId: "mac-2", deviceId: "sim" }, {});
  assert.deepEqual(ledger.open("device"), []);
});

test("structured content wins over text when a bridge supplies it", () => {
  assert.deepEqual(resultPayload([{ type: "text", text: "{\"a\":1}" }], { content: [], structuredContent: { b: 2 } }), { b: 2 });
  assert.deepEqual(resultPayload([{ type: "text", text: "{\"a\":1}" }], null), { a: 1 });
  assert.equal(resultPayload([{ type: "text", text: "not json" }]), undefined);
});

test("rebuild replays only this package's entries on the branch", () => {
  const ledger = new Ledger();
  rebuild(ledger, [
    { type: "custom", customType: ENTRY_TYPE, data: { kind: "preview", id: "tab-1", open: true } },
    { type: "custom", customType: "other", data: { kind: "preview", id: "tab-2", open: true } },
    { type: "message" },
    { type: "custom", customType: ENTRY_TYPE, data: { kind: "preview", id: "tab-1", open: false } },
    { type: "custom", customType: ENTRY_TYPE, data: { kind: "pr", id: "o/r#1", status: "watching" } },
  ]);
  assert.deepEqual(ledger.open().map(handle => handle.id), ["o/r#1"]);
});

const tools: ToolInfo[] = [
  ...["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task", "t3_preview_close", "t3_worktree_status"]
    .map(name => ({ name: `mcp__t3-code__${name}`, exposure: name === "delegate_task" ? "direct" : "deferred" })),
  { name: "mcp__t3_code__task_cancel", exposure: "hidden" },
  ...["grep", "find", "ls"].map(name => ({ name, exposure: "direct", sourceInfo: { source: "builtin", path: `builtin:${name}` } })),
];

test("loadouts declare existing T3 tools and, under supervision, Pi's read-only search", () => {
  const ledger = new Ledger();
  const base = { extra: [], ledger, allTools: tools };
  assert.deepEqual(desiredTools({ ...base, loadout: "lean", mode: "full-access" }), []);
  const standard = desiredTools({ ...base, loadout: "standard", mode: "full-access" });
  assert.deepEqual(standard, ["task_cancel", "t3_thread_read", "request_secret", "html_preview", "html_render", "watch_pull_request", "schedule_task"].map(name => `mcp__t3-code__${name}`));
  assert.deepEqual(desiredTools({ ...base, loadout: "lean", mode: "approval-required", extra: ["t3_worktree_status", "missing_tool"] }),
    ["mcp__t3-code__t3_worktree_status", "grep", "find", "ls"]);
  const full = desiredTools({ ...base, loadout: "full", mode: "full-access" });
  assert.equal(full.length, 12);
  assert.ok(!full.includes("mcp__t3_code__task_cancel"));
  // A tool named grep from an extension is not Pi's read-only builtin.
  assert.deepEqual(desiredTools({ ...base, allTools: [{ name: "grep", sourceInfo: { path: "/ext/grep.ts" } }], loadout: "lean", mode: "auto" }), []);
});

test("nextActive adds what is wanted and removes only what it added", () => {
  const first = nextActive(["read", "bash", "mcp__t3-code__html_render"], ["mcp__t3-code__html_render", "grep"], new Set());
  assert.deepEqual(first.active, ["read", "bash", "mcp__t3-code__html_render", "grep"]);
  assert.deepEqual([...first.managed], ["grep"]);
  assert.equal(first.changed, true);
  const second = nextActive(first.active, [], first.managed);
  assert.deepEqual(second.active, ["read", "bash", "mcp__t3-code__html_render"]);
  assert.equal(second.changed, true);
  assert.equal(nextActive(second.active, [], second.managed).changed, false);
});

test("the prompt section states mode, workspace, loadout and open handles", () => {
  const supervised = buildSection({
    mode: "approval-required",
    workspace: { root: "/home/u/.t3/worktrees/p/t3-1", branch: "feat/x", linked: true, mainCheckout: "/home/u/Code/p", t3Managed: true, defaultBranch: "origin/main" },
    declared: 1,
    ledger: "- watching PR o/r#1",
  });
  assert.match(supervised, /Permission mode: supervised\. T3 asks the user before every bash call/);
  assert.match(supervised, /branch `feat\/x` \(not pushed\), a worktree T3 created for this thread from `\/home\/u\/Code\/p`; default branch `origin\/main`/);
  assert.match(supervised, /Declared T3 tools: 1\b/);
  assert.match(supervised, /use `delegate_task`: it is your subagent tool/);
  assert.match(supervised, /### Open T3 handles[\s\S]*watching PR o\/r#1/);

  const full = buildSection({ mode: "full-access", declared: 31 });
  assert.match(full, /Permission mode: full access/);
  assert.match(full, /Declared T3 tools: 31\b/);
  assert.doesNotMatch(full, /Workspace:|Open T3 handles/);
  assert.match(buildSection({ mode: "auto-accept-edits", declared: 0 }), /auto-accept edits\. Edit and write run without asking/);
  assert.match(buildSection({ mode: "full-access", declared: 0, workspace: { root: "/r", branch: "main", upstream: "origin/main", linked: false, t3Managed: false } }),
    /the repository's main checkout\. Other T3 threads may share it/);
});

test("readWorkspace reports a T3 worktree from git", async () => {
  const replies: Record<string, string | undefined> = {
    "rev-parse": "/home/u/.t3/worktrees/p/t3-1\n/home/u/Code/p/.git/worktrees/t3-1\n/home/u/Code/p/.git",
    "branch": "feat/x",
    "worktree": "worktree /home/u/Code/p\nHEAD abc\nbranch refs/heads/main\n",
    "symbolic-ref": "origin/main",
    "rev-parse@{u}": undefined,
  };
  const exec: Exec = async (_command, args) => {
    const key = args.includes("@{u}") ? "rev-parse@{u}" : args[0]!;
    const stdout = replies[key];
    return stdout === undefined ? { stdout: "", code: 128 } : { stdout, code: 0 };
  };
  assert.deepEqual(await readWorkspace(exec, "/home/u/.t3/worktrees/p/t3-1"), {
    root: "/home/u/.t3/worktrees/p/t3-1", branch: "feat/x", linked: true, mainCheckout: "/home/u/Code/p", t3Managed: true, defaultBranch: "origin/main",
  });
  assert.equal(await readWorkspace(async () => ({ stdout: "", code: 128 }), "/tmp"), undefined);
  assert.equal(await readWorkspace(async () => { throw new Error("no git"); }, "/tmp"), undefined);
});

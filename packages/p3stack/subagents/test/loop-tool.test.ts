import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagents from "../extensions/subagents/index.js";
import { asHost } from "./host-env.js";
import { tempRoot } from "./support/temp-root.js";

const loops = { enabled: true, minIntervalMs: 1000, maxIterations: 2, maxDurationMs: 60_000 };

// The real extension with a fake Pi: a policy file in a private agent directory.
function harness(policy: Record<string, unknown>, hasUI = true) {
  const agentDir = tempRoot("loop-agent-");
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify({ version: 1, models: [{ id: "p/m:off" }], ...policy }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, Function[]>();
  const sent: { message: any; options: any }[] = [], notices: string[] = [], statuses: [string, string | undefined][] = [];
  const ctx = {
    cwd: agentDir, mode: "print", hasUI, isIdle: () => true, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [] },
    ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, text?: string) => statuses.push([key, text]) },
    sessionManager: { getEntries: () => [] },
  };
  asHost("cli", () => {
    subagents({
      registerFlag() {}, getFlag() { return false; },
      on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      sendMessage(message: any, options: any) { sent.push({ message, options }); },
      getAllTools: () => [], getCommands: () => [],
      events: { on: () => () => {} },
    } as unknown as ExtensionAPI);
    for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  });
  const call = (args: unknown) => tools.get("subagent_loop").execute("call", args, undefined, undefined, ctx);
  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  const dispose = async () => {
    await emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  };
  return { tools, commands, call, emit, sent, notices, statuses, ctx, dispose };
}

const text = (result: { content: { text: string }[] }) => result.content.map(part => part.text).join("\n");

test("without a loops policy the tool exists but refuses, saying how to enable it", async () => {
  const h = harness({});
  try {
    assert.ok(h.tools.has("subagent_loop"));
    await assert.rejects(h.call({ op: "start", task: "check CI", intervalSeconds: 60 }), /disabled by the subagents policy/);
    assert.match(text(await h.call({ op: "status" })), /no loop is running/i);
  } finally { await h.dispose(); }
});

test("a started loop wakes the idle parent with a bounded tick until it is stopped", async () => {
  const h = harness({ loops });
  try {
    const started = await h.call({ op: "start", task: "check CI", intervalSeconds: 1 });
    assert.match(text(started), /every 1s.*at most 2 ticks/s);
    assert.deepEqual(h.statuses.at(-1), ["loop", "loop 0/2 · every 1s"]);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.message.customType, "subagent-loop-tick");
    assert.match(h.sent[0]!.message.content, /^LOOP TICK 1\/2/);
    assert.match(h.sent[0]!.message.content, /Task: check CI/);
    assert.match(h.sent[0]!.message.content, /"op":"stop"/);
    assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
    const stopped = await h.call({ op: "stop" });
    assert.match(text(stopped), /Stopped the loop after 1 of 2 ticks/);
    assert.deepEqual(h.statuses.at(-1), ["loop", undefined]);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(h.sent.length, 1, "no tick after stop");
  } finally { await h.dispose(); }
});

test("a loop that reaches its bound says so in the transcript without starting a turn", async () => {
  const h = harness({ loops: { ...loops, maxIterations: 1 } });
  try {
    await h.call({ op: "start", task: "check CI", intervalSeconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepEqual(h.sent.map(entry => entry.message.customType), ["subagent-loop-tick", "subagent-loop-end"]);
    assert.match(h.sent[1]!.message.content, /reached 1 ticks/);
    assert.deepEqual(h.sent[1]!.options, { triggerTurn: false, deliverAs: "nextTurn" });
  } finally { await h.dispose(); }
});

test("/loop starts, reports and stops a loop, and stays silent on UI without one", async () => {
  const h = harness({ loops });
  try {
    await h.commands.get("loop").handler("30s watch the deploy", h.ctx);
    assert.match(h.notices.at(-1)!, /Started a loop: "watch the deploy" every 30s, at most 2 ticks/);
    await h.commands.get("loop").handler("", h.ctx);
    assert.match(h.notices.at(-1)!, /watch the deploy/);
    await h.commands.get("loop").handler("stop", h.ctx);
    assert.match(h.notices.at(-1)!, /Stopped the loop/);
    await h.commands.get("loop").handler("soon do things", h.ctx);
    assert.match(h.notices.at(-1)!, /Usage: \/loop/);
  } finally { await h.dispose(); }
  const headless = harness({ loops }, false);
  try {
    await headless.call({ op: "start", task: "check CI", intervalSeconds: 60 });
    assert.deepEqual(headless.statuses, []);
  } finally { await headless.dispose(); }
});

test("the catalog states the loop ceilings, or that loops are off", async () => {
  // The policy is read from the process-wide agent directory, so one harness at a time.
  const catalog = async (policy: Record<string, unknown>) => {
    const h = harness(policy);
    try { return JSON.parse(text(await h.tools.get("subagent_catalog").execute("c", {}, undefined, undefined, h.ctx))); }
    finally { await h.dispose(); }
  };
  assert.deepEqual((await catalog({ loops })).loops, loops);
  assert.deepEqual((await catalog({})).loops, { enabled: false });
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parsePolicy, SubagentPolicy, type PolicyEnvironment } from "../extensions/subagents/src/policy.js";
import { PeerClient, servePeer } from "../extensions/subagents/src/peer-transport.js";
import childGuard from "../extensions/subagents/src/child-guard.js";
import { relayWait, type WaitArgs } from "../extensions/subagents/src/wait.js";
import { fitDelegatedReply } from "../extensions/subagents/src/nesting.js";
import { tempRoot } from "./support/temp-root.js";

const base = { version: 1, models: [{ id: "p/m:off" }], tools: ["read", "subagent_spawn", "subagent_wait"] };

function policy(config: Record<string, unknown>) {
  const root = tempRoot("nesting-policy-"), agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "subagents.json"), JSON.stringify(config));
  const environment: PolicyEnvironment = {
    cwd: root, agentDir, projectTrusted: false, guardPath: "/internal/child-guard.ts",
    models: () => [{ provider: "p", id: "m", input: ["text"], contextWindow: 1000, maxTokens: 100, cost: {}, thinkingLevels: ["off"] }],
    tools: () => ["read", "subagent_spawn", "subagent_wait"],
  };
  return { root, policy: new SubagentPolicy(environment), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("delegation is off at the default depth: delegation tools are ignored with a diagnostic", () => {
  assert.equal(parsePolicy(base).maxDepth, undefined);
  const { policy: p, dispose } = policy(base);
  try {
    const catalog = p.catalog();
    assert.deepEqual(catalog.tools, ["read"]);
    assert.equal(catalog.maxDepth, 1);
    assert.ok(p.diagnostics.some(d => d.includes("delegation needs maxDepth above 1")));
    assert.throws(() => p.compile(dirname(p), { model: "p/m:off", tools: ["subagent_spawn"] }), /Tool not allowed: subagent_spawn/);
  } finally { dispose(); }
});

const dirname = (p: SubagentPolicy) => p.environment.cwd;

test("maxDepth allows delegation tools only for Children above the deepest level", () => {
  const { policy: p, dispose } = policy({ ...base, maxDepth: 2 });
  try {
    assert.deepEqual(p.catalog().tools, ["read", "subagent_spawn", "subagent_wait"]);
    const coordinator = p.compile(dirname(p), { model: "p/m:off", tools: ["read", "subagent_spawn"] }, 1);
    assert.equal(coordinator.childPolicy?.toolSources.subagent_spawn, "/internal/child-guard.ts", "proxies come from the guard");
    assert.throws(() => p.compile(dirname(p), { model: "p/m:off", tools: ["subagent_spawn"] }, 2), /depth 2 cannot delegate: maxDepth is 2/);
    assert.ok(p.compile(dirname(p), { model: "p/m:off", tools: ["read"] }, 2), "a leaf without delegation tools is fine");
    assert.throws(() => p.compile(dirname(p), { model: "p/m:off", tools: ["read"] }, 3), /No Child may run at depth 3: maxDepth is 2/);
  } finally { dispose(); }
});

test("maxDepth is bounded and delegation can never be always-on", () => {
  for (const maxDepth of [0, 5, 1.5, "2"]) assert.throws(() => parsePolicy({ ...base, maxDepth }), /maxDepth/);
  assert.throws(() => parsePolicy({ ...base, maxDepth: 2, alwaysTools: ["subagent_spawn"] }), /alwaysTools cannot include delegation tools/);
});

test("tools that manage peers, holds or workflows stay parent-only at any depth", () => {
  const { policy: p, dispose } = policy({ ...base, maxDepth: 2, tools: ["read", "subagent_connect", "subagent_workflow_start"] });
  try {
    assert.deepEqual(p.catalog().tools, ["read"]);
    assert.ok(p.diagnostics.some(d => d.includes("Forbidden recursive tool (ignored): subagent_connect")));
    assert.throws(() => p.compile(dirname(p), { model: "p/m:off", tools: ["subagent_connect"] }, 1), /Tool not allowed: subagent_connect/);
  } finally { dispose(); }
});

async function pair() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const accept = once(server, "connection");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = connect(address.port, "127.0.0.1");
  const [remote] = await accept as [Socket];
  client.setEncoding("utf8");
  const replies: any[] = [];
  client.on("data", chunk => { for (const line of String(chunk).split("\n").filter(Boolean)) replies.push(JSON.parse(line)); });
  const next = async (count: number) => { while (replies.length < count) await new Promise(resolve => setTimeout(resolve, 5)); return replies; };
  return { client, remote, next, close: () => { client.destroy(); remote.destroy(); server.close(); } };
}

test("the private pipe carries management calls only when enabled, and only in their exact shape", async () => {
  const off = await pair();
  try {
    servePeer(off.remote, async () => ({}));
    off.client.write(JSON.stringify({ id: 1, op: "spawn", args: {} }) + "\n");
    assert.match((await off.next(1))[0].error, /delegation is not enabled/);
  } finally { off.close(); }
  const on = await pair(); const calls: unknown[] = [];
  try {
    servePeer(on.remote, undefined, async request => { calls.push(request); return { ok: true }; });
    on.client.write(JSON.stringify({ id: 1, op: "spawn", args: { name: "x" } }) + "\n");
    on.client.write(JSON.stringify({ id: 2, op: "connect", args: {} }) + "\n");
    on.client.write(JSON.stringify({ id: 3, op: "wait", args: [] }) + "\n");
    on.client.write(JSON.stringify({ id: 4, op: "read", args: {}, caller: "someone-else" }) + "\n");
    on.client.write(JSON.stringify({ id: 5, recipient: "B", message: "peer" }) + "\n");
    const replies = await on.next(5);
    const byId = new Map(replies.map(reply => [reply.id, reply]));
    assert.deepEqual(byId.get(1), { id: 1, success: true, data: { ok: true } });
    for (const id of [2, 3, 4, 5]) assert.equal(byId.get(id).success, false, String(id));
    assert.deepEqual(calls, [{ op: "spawn", args: { name: "x" } }], "the caller is never taken from the packet");
  } finally { on.close(); }
});

function guard(env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const tools = new Map<string, any>(), handlers = new Map<string, Function[]>();
  try {
    childGuard({
      registerTool: (tool: any) => tools.set(tool.name, { ...tool, sourceInfo: { path: new URL("../extensions/subagents/src/child-guard.ts", import.meta.url).pathname } }),
      getAllTools: () => [...tools.values()],
      on: (name: string, handler: Function) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
      registerCommand() {}, setActiveTools() {}, getActiveTools: () => [...tools.keys()],
    } as unknown as ExtensionAPI);
  } finally { process.env = saved; }
  const blocked = (toolName: string) => handlers.get("tool_call")!.some(handler => handler({ toolName }, {})?.block);
  return { tools, blocked };
}

test("a Child gets proxies only for the delegation tools it was given, and only with its private pipe", () => {
  const withPipe = guard({ PI_SUBAGENT: "1", PI_SUBAGENT_ALLOWED_TOOLS: JSON.stringify(["subagent_spawn", "subagent_wait", "subagent_connect"]), PI_SUBAGENT_PEER_FD: "3" });
  assert.deepEqual([...withPipe.tools.keys()].sort(), ["subagent_spawn", "subagent_wait"]);
  assert.match(withPipe.tools.get("subagent_spawn").description, /acts only on Children you spawned/);
  assert.equal(withPipe.blocked("subagent_spawn"), false);
  assert.equal(withPipe.blocked("subagent_connect"), true, "never proxied");
  assert.equal(withPipe.blocked("subagent_list"), true, "not selected");
  const withoutPipe = guard({ PI_SUBAGENT: "1", PI_SUBAGENT_ALLOWED_TOOLS: JSON.stringify(["subagent_spawn"]) });
  assert.equal(withoutPipe.tools.size, 0);
  assert.equal(withoutPipe.blocked("subagent_spawn"), true);
});

async function socketPair() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const accept = once(server, "connection");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const client = connect(address.port, "127.0.0.1");
  const [remote] = await accept as [Socket];
  return { client, remote, close: () => { client.destroy(); remote.destroy(); server.close(); } };
}

test("a cancelled delegated call is cancelled in the root too", async () => {
  const sockets = await socketPair();
  try {
    let cancelled!: (reason: unknown) => void;
    const seen = new Promise(resolve => { cancelled = resolve; });
    servePeer(sockets.remote, undefined, (_request, signal) => new Promise(() => { signal.addEventListener("abort", () => cancelled(signal.reason)); }));
    const client = new PeerClient(sockets.client), stop = new AbortController();
    const call = client.manage("wait", { collect: true }, stop.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    stop.abort();
    await assert.rejects(call, /interrupted or timed out/);
    assert.match(String(await seen), /cancelled this call/);
  } finally { sockets.close(); }
});

async function relay(answer: (args: WaitArgs, signal: AbortSignal) => Promise<unknown>) {
  const sockets = await socketPair(), calls: WaitArgs[] = [];
  servePeer(sockets.remote, undefined, (request, signal) => { calls.push(request.args as WaitArgs); return answer(request.args as WaitArgs, signal); });
  const client = new PeerClient(sockets.client);
  const wait = (args: WaitArgs, signal?: AbortSignal, messageQueued = () => false) =>
    relayWait((relayed, segment) => client.manage("wait", relayed, segment), args, signal, messageQueued);
  return { calls, wait, close: sockets.close };
}

test("a Child's unbounded wait relays bounded segments that collect nothing, then collects once", async () => {
  let segments = 0;
  const r = await relay(async args => args.timeoutSeconds === 0
    ? { wake: "settled", agents: [{ id: "w", reports: [{ kind: "assistant", text: "done" }] }] }
    : { wake: ++segments <= 2 ? "timeout" : "settled", agents: [] });
  try {
    assert.deepEqual(await r.wait({ ids: ["w"] }), { wake: "settled", agents: [{ id: "w", reports: [{ kind: "assistant", text: "done" }] }] });
    const [final, ...rest] = [...r.calls].reverse();
    assert.deepEqual(final, { ids: ["w"], timeoutSeconds: 0 }, "one last call with the caller's collect");
    assert.equal(rest.length, 3);
    for (const segment of rest) {
      assert.equal(segment.collect, false);
      assert.ok(segment.timeoutSeconds! > 0 && segment.timeoutSeconds! <= 60, String(segment.timeoutSeconds));
    }
  } finally { r.close(); }
});

test("a message queued for the Child cancels the segment in the root and ends its wait with message", async () => {
  let cancelled!: (reason: unknown) => void;
  const seen = new Promise(resolve => { cancelled = resolve; });
  const r = await relay((args, signal) => args.timeoutSeconds === 0
    ? Promise.resolve({ wake: "timeout", agents: [] })
    : new Promise(() => { signal.addEventListener("abort", () => cancelled(signal.reason)); }));
  try {
    let queued = false;
    setTimeout(() => { queued = true; }, 50);
    assert.deepEqual(await r.wait({}, undefined, () => queued), { wake: "message", agents: [] });
    assert.match(String(await seen), /cancelled this call/);
    assert.deepEqual(r.calls.map(call => call.collect), [false, undefined]);
  } finally { r.close(); }
});

test("timeoutSeconds 0 makes exactly one relayed call, and aborting a relayed wait collects nothing", async () => {
  const r = await relay((args, signal) => args.timeoutSeconds === 0
    ? Promise.resolve({ wake: "timeout", agents: [] })
    : new Promise(() => { signal.addEventListener("abort", () => {}); }));
  try {
    assert.deepEqual(await r.wait({ timeoutSeconds: 0, collect: false }), { wake: "timeout", agents: [] });
    assert.deepEqual(r.calls, [{ timeoutSeconds: 0, collect: false }]);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(r.wait({}, stop.signal), /abort/i);
    assert.deepEqual(r.calls.slice(1).map(call => call.collect), [false], "no collecting call for a caller that is gone");
  } finally { r.close(); }
});

test("a truncated segment reply ends the relay, and the collecting call returns its preview", async () => {
  const truncated = fitDelegatedReply({ wake: "timeout", agents: [{ error: "e".repeat(70_000) }] });
  const r = await relay(async () => truncated);
  try {
    assert.deepEqual(await r.wait({ ids: ["w"] }), truncated);
    assert.deepEqual(r.calls.map(call => call.collect), [false, undefined], "one segment, then one collecting call");
  } finally { r.close(); }
});

test("a relayed wait refuses a reply that is neither a report nor a truncated preview", async () => {
  const r = await relay(async () => ({ agents: [] }));
  try {
    await assert.rejects(r.wait({ ids: ["w"] }), /Unexpected reply to a relayed wait/);
  } finally { r.close(); }
});

test("an oversized delegated request is refused before it is sent, and the pipe stays usable", async () => {
  const sockets = await socketPair();
  try {
    servePeer(sockets.remote, undefined, async request => ({ echoed: request.op }));
    const client = new PeerClient(sockets.client);
    await assert.rejects(client.manage("send", { id: "x", message: "漢".repeat(23000) }), /too large for the private pipe/);
    assert.deepEqual(await client.manage("list", {}), { echoed: "list" });
  } finally { sockets.close(); }
});

test("a cancellation is sent even when the pipe is backed up", async () => {
  const sockets = await socketPair();
  try {
    const written: string[] = [];
    const client = new PeerClient(sockets.client);
    const stop = new AbortController();
    const call = client.manage("wait", {}, stop.signal);
    // Simulate a backed-up pipe: ordinary requests would now be refused.
    Object.defineProperty(sockets.client, "writableLength", { get: () => 1024 * 1024 });
    const write = sockets.client.write.bind(sockets.client);
    sockets.client.write = ((chunk: string, ...rest: never[]) => { written.push(String(chunk)); return write(chunk, ...rest); }) as typeof sockets.client.write;
    stop.abort();
    await assert.rejects(call);
    assert.deepEqual(written.map(line => JSON.parse(line)), [{ cancel: 1 }]);
  } finally { sockets.close(); }
});

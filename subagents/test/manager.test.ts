import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SubagentManager, type Notice } from "../src/manager.js";
import { JsonlDecoder } from "../src/rpc.js";
const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
async function setup(limit = 4) {
  const dir = await mkdtemp(join(tmpdir(), "subagent-test-"));
  const notices: Notice[] = [];
  const manager = new SubagentManager(dir, n => notices.push(n), undefined, limit);
  const spawn = (task: string) => manager.spawn({ name: task, task, cwd: dir, executable: process.execPath, executableArgs: [fixture] });
  return { dir, manager, spawn, notices, async cleanup() { await manager.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}

test("JSONL framing preserves Unicode separators and split records", () => {
  const packets: unknown[] = [];
  const decoder = new JsonlDecoder(packet => packets.push(packet));
  decoder.push('{"text":"a\u2028b\u2029');
  decoder.push('c"}\r\n\n{"n":2}\n');
  assert.deepEqual(packets, [{ text: "a\u2028b\u2029c" }, { n: 2 }]);
  assert.throws(() => new JsonlDecoder(() => {}, 8).push("123456789"), /exceeded/);
});

test("parallel children, incremental read, follow-up and usage", async () => {
  const s = await setup();
  try {
    const [a, b] = await Promise.all([s.spawn("alpha"), s.spawn("beta")]);
    assert.notEqual(a.id, b.id);
    const settled = await s.manager.wait([a.id, b.id], "all", 2000);
    assert.equal(settled.timedOut, false);
    assert.equal(settled.agents.every(a => a.status === "idle"), true);
    const first = s.manager.read(a.id);
    assert.ok(first.updates.some(u => u.text === "1:alpha"));
    assert.equal(s.manager.read(a.id).updates.length, 0);
    await s.manager.send(a.id, "follow-up");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:follow-up"));
    assert.equal(s.notices.filter(n => n.kind === "completed").length, 3);
    assert.equal(s.manager.read(a.id, 0).gap, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((s.manager.get(a.id).usage as { userMessages: number }).userMessages, 2);
  } finally { await s.cleanup(); }
});

test("acceptance before agent_start cannot cause a premature idle result", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("accept-before-start");
    assert.equal(a.status, "working");
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "late start finished"));
  } finally { await s.cleanup(); }
});

test("abort retains process, redirection works; resuming a live child must not close it", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("slow initial");
    const pid = a.pid;
    await assert.rejects(s.manager.resume(a.id), /already has a process/);
    assert.equal(s.manager.get(a.id).pid, pid);
    assert.equal((await s.manager.wait([a.id], "all", 0)).timedOut, true);
    await assert.rejects(s.manager.send(a.id, "unqualified"), /Already working/);
    await s.manager.abort(a.id);
    assert.equal(s.manager.get(a.id).status, "idle");
    assert.equal(s.manager.get(a.id).pid, pid);
    await s.manager.send(a.id, "redirect");
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "2:redirect"));
    await s.manager.close(a.id);
    await s.manager.close(a.id);
    assert.equal(s.manager.get(a.id).status, "stopped");
    assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  } finally { await s.cleanup(); }
});

test("shutdown restores stopped metadata and resumes the saved conversation", async () => {
  const s = await setup();
  let restored: SubagentManager | undefined;
  try {
    const a = await s.spawn("alpha");
    await s.manager.wait([a.id], "all", 2000);
    await s.manager.shutdown();
    restored = new SubagentManager(s.dir);
    assert.equal(restored.get(a.id).status, "stopped");
    assert.equal(restored.get(a.id).pid, undefined);
    await restored.resume(a.id, "remember");
    await restored.wait([a.id], "all", 2000);
    assert.ok(restored.read(a.id).updates.some(u => u.text === "2:remember"));
  } finally { await restored?.shutdown(); await s.cleanup(); }
});

test("dialog requests surface and can be answered explicitly", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("ui");
    const state = await s.manager.wait([a.id], "all", 2000);
    assert.equal(state.needsInput, true);
    assert.equal(s.manager.read(a.id).uiRequests[0].id, "ui-1");
    s.manager.respond(a.id, "ui-1", { confirmed: false });
    await s.manager.wait([a.id], "all", 2000);
    assert.ok(s.manager.read(a.id).updates.some(u => u.text === "confirmed=false"));
    assert.throws(() => s.manager.respond(a.id, "ui-1", { cancelled: true }), /Unknown/);
  } finally { await s.cleanup(); }
});

test("failed runs stay addressable; crashes and bad protocol are reported", async () => {
  const s = await setup();
  try {
    const a = await s.spawn("error");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "failed");
    await s.manager.send(a.id, "recover");
    await s.manager.wait([a.id], "all", 2000);
    assert.equal(s.manager.get(a.id).status, "idle");
    await assert.rejects(s.spawn("crash"), /Child exited/);
    await assert.rejects(s.spawn("malformed"), /JSON|Unexpected/);
  } finally { await s.cleanup(); }
});

test("concurrency, reserved flags, env persistence, and cancelled waits", async () => {
  const s = await setup(1);
  try {
    const a = await s.manager.spawn({ name: "slow", task: "slow", cwd: s.dir, executable: process.execPath, executableArgs: [fixture], env: { TEST_SECRET: "never-persist-me" } });
    await assert.rejects(s.spawn("over limit"), /limit/);
    const signal = AbortSignal.abort();
    await assert.rejects(s.manager.wait([a.id], "all", 1000, signal), /abort/i);
    assert.equal(s.manager.get(a.id).status, "working");
    const registry = await readFile(join(s.dir, "registry.json"), "utf8");
    assert.equal(registry.includes("never-persist-me"), false);
    await s.manager.close(a.id);
    await assert.rejects(s.manager.resume(a.id), /environment overrides/);
    await assert.rejects(s.manager.spawn({ name: "bad", task: "x", cwd: s.dir, cliArgs: ["--no-session"] }), /manager-owned/);
  } finally { await s.cleanup(); }
});

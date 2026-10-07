import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = process.env.PEER_TEST_CLI ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const executable = process.env.PEER_TEST_EXECUTABLE ?? process.execPath;
const executableArgs = process.env.PEER_TEST_EXECUTABLE ? [] : [cli];
const fixture = fileURLToPath(new URL("./fixtures/t3-runtime.mjs", import.meta.url));
const native = fileURLToPath(new URL("../../subagents/extensions/subagents/index.ts", import.meta.url));
const extension = fileURLToPath(new URL("../extensions/t3-subagents/index.ts", import.meta.url));

function start(root: string, disabled: boolean, session = join(root, "session.jsonl")) {
  const agent = join(root, "agent");
  mkdirSync(agent, { recursive: true });
  const child = spawn(executable, [...executableArgs, "--mode", "rpc", "--session", session,
    "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates",
    "-e", fixture, "-e", native, "-e", extension, "--model", "t3-test/stub:off",
    ...(disabled ? ["--disable-native-subagents"] : [])], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events: any[] = [];
  let buffer = "", stderr = "", sequence = 0;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { events.push(JSON.parse(line)); } catch { stderr += line + "\n"; }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(stderr + "\n" + JSON.stringify(events));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const send = async (packet: Record<string, unknown>) => {
    const id = String(++sequence);
    child.stdin.write(JSON.stringify({ ...packet, id }) + "\n");
    await wait(() => events.some(e => e.type === "response" && e.id === id));
    const reply = events.find(e => e.type === "response" && e.id === id);
    assert.equal(reply.success, true, JSON.stringify(reply));
    return reply.data;
  };
  return {
    agent, events, wait, send,
    async snapshot() {
      const from = events.length;
      await send({ type: "prompt", message: "/fixture" });
      const probe = (e: any) => e.type === "extension_ui_request" && e.method === "notify" && e.message?.startsWith("FIXTURE SNAPSHOT:");
      await wait(() => events.slice(from).some(probe));
      return JSON.parse(events.slice(from).find(probe).message.slice("FIXTURE SNAPSHOT:".length));
    },
    async run(op: string) {
      const from = events.length;
      await send({ type: "prompt", message: op });
      await wait(() => events.slice(from).some(e => e.type === "agent_end"));
      const message = (await send({ type: "get_messages" })).messages.filter((m: any) => m.role === "toolResult").at(-1);
      assert.ok(message, JSON.stringify(events));
      return message;
    },
    async stop() {
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
      await closed; clearTimeout(timeout);
    },
  };
}

test("real RPC: native opt-out preserves unrelated extensions, T3 tasks and hook checks", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-subagents-rpc-"));
  let rpc = start(root, true);
  try {
    const before = await rpc.snapshot();
    assert.ok(!before.tools.some((name: string) => name.startsWith("subagent_")));
    assert.ok(before.tools.includes("mcp__t3-code__delegate_task"));
    assert.ok(before.tools.includes("t3_subagent_delegate"));
    const commands = await rpc.send({ type: "get_commands" });
    assert.ok(!commands.commands.some((c: any) => ["subagents", "workflows"].includes(c.name)));
    assert.equal(existsSync(join(rpc.agent, "subagents")), false);
    await rpc.send({ type: "prompt", message: "/fixture reload" });
    assert.ok(!(await rpc.snapshot()).tools.some((name: string) => name.startsWith("subagent_")));
    assert.equal(existsSync(join(rpc.agent, "subagents")), false);
    assert.equal((await rpc.run("catalog")).isError, false);
    const delegated = await rpc.run("delegate");
    assert.equal(delegated.isError, false);
    assert.equal(JSON.parse(delegated.content[0].text).taskId, "fixture-task");
    assert.equal(JSON.parse((await rpc.run("read")).content[0].text).summary, "Fixture result.");
    assert.ok(JSON.parse((await rpc.run("long-id")).content[0].text).taskId.length > 256);
    assert.equal(JSON.parse((await rpc.run("cancel")).content[0].text).status, "cancel_requested");
    const beforeInvalid = (await rpc.snapshot()).calls.length;
    assert.equal((await rpc.run("unsupported")).isError, true); // No prompt-only composition fallback.
    assert.equal((await rpc.snapshot()).calls.length, beforeInvalid);
    await rpc.send({ type: "prompt", message: "/fixture block" });
    const blocked = await rpc.run("read");
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Fixture permission declined/);
    assert.equal((await rpc.snapshot()).calls.length, beforeInvalid);
    assert.equal(rpc.events.filter(e => e.type === "message_end" && e.message?.customType === "subagent-report").length, 0);
    await rpc.stop();
    rpc = start(root, true); // Same saved branch, fresh extension instance/fixture.
    const replay = await rpc.run("delegate");
    assert.equal(replay.isError, false);
    assert.equal(JSON.parse(replay.content[0].text).taskId, "fixture-task");
    assert.deepEqual((await rpc.snapshot()).calls, []);
    assert.equal(existsSync(join(rpc.agent, "subagents")), false);
    assert.equal(rpc.events.some(e => e.type === "extension_error"), false);
  } finally {
    await rpc.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real RPC: an unflagged standalone launch keeps native delegation and workflow startup", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "t3-subagents-native-"));
  const rpc = start(root, false);
  try {
    const snapshot = await rpc.snapshot();
    assert.ok(snapshot.tools.includes("subagent_spawn"));
    assert.ok(snapshot.tools.includes("subagent_workflow_start"));
    assert.equal(existsSync(join(rpc.agent, "subagents")), true);
    assert.equal((await rpc.run("delegate")).isError, true); // Explicit opt-out required if both packages load.
    assert.deepEqual((await rpc.snapshot()).calls, []);
  } finally {
    await rpc.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

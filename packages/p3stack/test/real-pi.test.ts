import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const path = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
type Packet = Record<string, any>;

const provider = path("../todo/test/fixtures/todo-provider.mjs");
function rpc(t: TestContext, env: NodeJS.ProcessEnv = {}, extensions: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-rpc-")), requests = join(root, "requests.jsonl");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const proc = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--session", join(root, "session.jsonl"),
    "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--approve",
    ...extensions.flatMap(e => ["-e", e]), "-e", path("../extensions/p3stack/index.ts"), "-e", provider, "--model", "todo-test/stub"], {
    cwd: root, env: { PATH: `${root}:${process.env.PATH}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_TEST_REQUESTS: requests,
      PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", ...env },
  });
  const closed = once(proc, "close");
  t.after(async () => { proc.kill(); await closed; rmSync(root, { recursive: true, force: true }); });
  let stderr = "";
  proc.stderr.on("data", chunk => { stderr += chunk; });
  const events: Packet[] = [];
  createInterface({ input: proc.stdout }).on("line", line => events.push(JSON.parse(line)));
  function send(packet: Packet) {
    const from = events.length;
    proc.stdin.write(JSON.stringify(packet) + "\n");
    return from;
  }
  async function wait(from: number, match: (event: Packet) => boolean, ms = 20000) {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
      const found = events.slice(from).find(match);
      if (found) return found;
      assert.equal(proc.exitCode, null, stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`No matching RPC event: ${stderr}\n${events.slice(from).map(e => e.type).join(", ")}`);
  }
  return { send, wait, root, requests: () => existsSync(requests) ? readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line) as Packet) : [] };
}

for (const host of ["terminal", "t3"]) test(`${host}: provider requests scope routing to this request and preserve the user's grant and correction`, async t => {
  const pi = rpc(t, host === "t3" ? { T3_MCP_URL: "http://t3.invalid/mcp" } : {});
  const prompt = async (message: string) => {
    const from = pi.send({ type: "prompt", message });
    await pi.wait(from, e => message.startsWith("/") ? e.type === "response" && e.success : e.type === "agent_settled");
  };
  const design = "Discuss the design only. Do not implement it.";
  const oneTask = "For this task only, use full autonomy to recommend one design. Stop at the recommendation.";
  const correction = "Correction: leave the design unchanged. Explain the current interface.";
  await prompt("/p3stack on default");
  await prompt(design);
  await prompt(oneTask);
  await prompt("/p3stack off");
  await prompt(correction);
  const requests = pi.requests();
  assert.equal(requests.length, 3);
  for (const [i, request] of requests.entries()) {
    const users = request.messages.filter((m: Packet) => m.role === "user").map((m: Packet) =>
      typeof m.content === "string" ? m.content : m.content.map((p: Packet) => p.text).join("\n"));
    const notes = users.filter((s: string) => s.includes("p3stack-mode is on"));
    assert.deepEqual(users.filter((s: string) => !notes.includes(s)), [design, oneTask, correction].slice(0, i + 1));
    if (i < 2) {
      assert.match(request.system, new RegExp(`Grant: default\\. Host: ${host}`), "the user's one-task raise does not change the saved grant");
      assert.equal(notes.length, 1, "exactly one current route reminder beside the request");
      assert.equal(users.at(-1), notes[0]);
      assert.match(notes[0], /within the user\x27s requested scope and stopping point/);
    } else {
      assert.doesNotMatch(request.system, /<p3stack>/);
      assert.doesNotMatch(JSON.stringify(request.messages), /p3stack-mode\/SKILL\.md/);
      assert.deepEqual(notes, [], "no replay of an old mode-on instruction after off");
    }
  }
});

test("the T3 RPC approval text matches the transported task byte for byte", async t => {
  const pi = rpc(t, { T3_MCP_URL: "http://t3.invalid/mcp", T3_PI_RUNTIME_MODE: "approval-required" }, [path("./fixtures/supervised-bridge.mjs")]);
  const call = (name: string, args: object) => pi.send({ type: "prompt", message: "CALL " + JSON.stringify({ name, arguments: args }) });
  let from = pi.send({ type: "prompt", message: "/p3stack on autonomous" });
  await pi.wait(from, e => e.type === "response" && e.success);
  from = call("p3stack_roles", {});
  const roles = await pi.wait(from, e => e.type === "tool_execution_end" && e.toolName === "p3stack_roles");
  await pi.wait(from, e => e.type === "agent_settled");
  const report = roles.result.structuredContent.briefHeaders.report;
  const input = { task: report.replace("Grant: full-autonomy.", "Task grant: default") + "\n\nInspect the parser. Return evidence only.", role: "review" };
  const delegate = "mcp__t3-code__delegate_task";
  from = call(delegate, input);
  const dialog = await pi.wait(from, e => e.type === "extension_ui_request" && e.method === "confirm");
  const approved = JSON.parse(dialog.message);
  assert.deepEqual(approved, input);
  pi.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });
  const delivered = await pi.wait(from, e => e.type === "tool_execution_end" && e.toolName === delegate);
  assert.deepEqual(delivered.result.details, approved);
  assert.doesNotMatch(delivered.result.content[0].text, /full-autonomy/);
});

for (const route of ["nested", "workflow"]) test(`native ${route} initial delivery carries the worker's scope and grant`, { skip: process.platform === "win32" }, async t => {
  const pi = rpc(t, {}, [path("../subagents/extensions/subagents/index.ts")]);
  writeFileSync(join(pi.root, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${cli}' "$@"\n`, { mode: 0o700 });
  const delegation = ["subagent_spawn", "subagent_read", "subagent_wait"];
  const worker = { model: "todo-test/stub:off", tools: [] as string[], extensions: [provider] };
  writeFileSync(join(pi.root, "agent", "subagents.json"), JSON.stringify({ version: 1, models: [{ id: worker.model }], extensions: [provider], tools: delegation, maxDepth: 2 }));
  const goal = "Inspect the importer and return findings only.";
  const call = (name: string, args: object) => `CALL ${JSON.stringify({ name, arguments: args })}`;
  let prompt: string;
  if (route === "nested") {
    const leaf = call("subagent_spawn", { ...worker, name: "leaf", task: goal, cwd: pi.root });
    prompt = call("subagent_spawn", { ...worker, tools: delegation, name: "coordinator", cwd: pi.root, task: `Task grant: default\nDelegate one inspection.\n${leaf}` });
  } else {
    const definition = join(pi.root, "inspect.json");
    writeFileSync(definition, JSON.stringify({ version: 1, name: "inspect", cwd: pi.root, limits: { concurrency: 1, maxAttempts: 1, timeoutSeconds: 15 },
      steps: [{ kind: "task", id: "inspect", instructions: goal, worker }] }));
    prompt = call("subagent_workflow_start", { path: definition });
  }
  let from = pi.send({ type: "prompt", message: "/p3stack on autonomous" });
  await pi.wait(from, e => e.type === "response" && e.success);
  if (route === "workflow") {
    // Workflow tools are declared on demand: an ordinary parent names the one it needs first.
    from = pi.send({ type: "prompt", message: call("subagent_catalog", { activate: ["subagent_workflow_start"] }) });
    const activated = await pi.wait(from, e => e.type === "tool_execution_end");
    assert.ok(!activated.isError, JSON.stringify(activated.result));
    await pi.wait(from, e => e.type === "agent_settled");
  }
  from = pi.send({ type: "prompt", message: prompt });
  const result = await pi.wait(from, e => e.type === "tool_execution_end");
  assert.ok(!result.isError, JSON.stringify(result.result));
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    // Read the worker's provider request, not the parent's spawn arguments or registry.
    const texts: string[] = pi.requests().flatMap(r => r.messages.filter((m: Packet) => m.role === "user").flatMap((m: Packet) =>
      typeof m.content === "string" ? m.content : m.content.map((p: Packet) => p.text)));
    const delivered = texts.find(text => text.split("\n").includes(goal));
    if (delivered) {
      assert.match(delivered, route === "nested" ? /Grant: default\./ : /Grant: full-autonomy\./);
      assert.match(delivered, /report-only delegate/);
      if (route === "workflow") assert.match(delivered, /Write candidate files only under:/);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("no initial worker assignment reached the fixture provider");
});

test("an unanswered RPC dialog reaches its deadline; an explicit dismissal does not", async t => {
  const pi = rpc(t, { P3STACK_ASK_TIMEOUT_MS: "400" });
  for (const action of ["dismiss", "timeout", "other-timeout"]) {
    const args = { question: "Where?", default: "here", ...(action !== "timeout" && { options: ["here"], allowOther: true }) };
    const from = pi.send({ type: "prompt", message: `CALL ${JSON.stringify({ name: "ask_user", arguments: args })}` });
    const dialog = await pi.wait(from, e => e.type === "extension_ui_request" && (e.method === "input" || e.method === "select"));
    if (action === "dismiss") pi.send({ type: "extension_ui_response", id: dialog.id, cancelled: true });
    if (action === "other-timeout") {
      pi.send({ type: "extension_ui_response", id: dialog.id, value: "Other (type an answer)" });
      await pi.wait(from, e => e.type === "extension_ui_request" && e.method === "input");
    }
    const result = await pi.wait(from, e => e.type === "tool_execution_end" && e.toolName === "ask_user", 3000);
    const text = result.result.content[0].text;
    assert.match(text, action === "dismiss" ? /dismissed/i : /deadline|timed out/i);
    if (action !== "dismiss") assert.doesNotMatch(text, /dismissed/i);
    assert.match(text, /apply your default \(here\)/i);
    await pi.wait(from, e => e.type === "agent_settled");
  }
});

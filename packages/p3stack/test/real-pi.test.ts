import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const path = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
type Packet = Record<string, any>;

function rpc(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "p3stack-rpc-")), requests = join(root, "requests.jsonl");
  const proc = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--session", join(root, "session.jsonl"),
    "--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--approve",
    "-e", path("../extensions/p3stack/index.ts"), "-e", path("../todo/test/fixtures/todo-provider.mjs"), "--model", "todo-test/stub"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_TEST_REQUESTS: requests,
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
  return { send, wait, root, requests: () => readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line) as Packet) };
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
    } else {
      assert.doesNotMatch(request.system, /<p3stack>/);
      assert.deepEqual(notes, [], "no replay of an old mode-on instruction after off");
    }
  }
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

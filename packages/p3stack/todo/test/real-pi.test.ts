import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const extension = fileURLToPath(new URL("../extensions/todo/index.ts", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/todo-provider.mjs", import.meta.url));
type Packet = Record<string, any>;

// One Pi process in RPC mode, isolated from the developer's agent directory.
function pi(root: string, session: string) {
  const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--session", session, "--no-extensions", "--no-skills",
    "--no-themes", "--no-prompt-templates", "--no-context-files", "--approve", "-e", extension, "-e", provider, "--model", "todo-test/stub"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PI_TEST_REQUESTS: join(root, "requests.jsonl"), PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" },
  });
  const events: Packet[] = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on("line", line => { try { events.push(JSON.parse(line)); } catch { /* not a packet */ } });
  const until = async (predicate: (event: Packet) => boolean, from: number) => {
    for (const deadline = Date.now() + 15000; !events.slice(from).some(predicate); await new Promise(resolve => setTimeout(resolve, 20))) {
      assert.ok(Date.now() < deadline, `${stderr}\n${JSON.stringify(events.slice(-6))}`);
    }
  };
  let id = 0;
  async function prompt(message: string) {
    const from = events.length;
    child.stdin.write(JSON.stringify({ id: String(++id), type: "prompt", message }) + "\n");
    await until(event => event.type === "agent_settled", from);
    return from;
  }
  return {
    prompt,
    async call(args: unknown) {
      const from = await prompt(`CALL ${JSON.stringify(args)}`);
      const result = events.slice(from).find(event => event.type === "tool_execution_end" && event.toolName === "todo");
      assert.ok(result, `no todo call\n${stderr}`);
      return { text: result.result.content.map((part: Packet) => part.text).join("\n") as string, isError: result.isError === true };
    },
    stop: () => new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); }),
  };
}

// Count streamSimple invocations, not just settle events. The file (not the todo
// state or the model's reply) tells us whether the open item was actually finished.
for (const scenario of ["forgotten update", "waiting on user", "already current"]) test(`settle turn cost: ${scenario}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "todo-settle-")), session = join(root, "session.jsonl");
  const client = pi(root, session);
  try {
    const waiting = scenario === "waiting on user";
    const set = { op: "set", items: [waiting ? "Collect the user's signed receipt" : "Write receipt.txt"] };
    const work = waiting ? { name: "ls", arguments: { path: "." } } : { name: "write", arguments: { path: "receipt.txt", content: "received" } };
    const update = { op: "update", id: 1, state: "done" };
    const steps = scenario === "already current" ? [set, work, update, null] : [set, work, null, waiting ? null : update];
    await client.prompt(`RUN ${JSON.stringify(steps)}`);
    assert.equal(existsSync(join(root, "receipt.txt")), !waiting);
    const entries = readFileSync(session, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.filter(e => e.customType === "todo").at(-1).data.items[0].state, waiting ? "pending" : "done");
    const requests = readFileSync(join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const extra = requests.filter(({ messages }) => messages.some((m: Packet) => m.role === "user" && JSON.stringify(m.content).includes("The run is ending with")));
    assert.equal(extra.length, scenario === "already current" ? 0 : waiting ? 1 : 2);
    assert.equal(requests.length - extra.length, scenario === "already current" ? 4 : 3);
  } finally { await client.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("a real Pi session keeps the list across a restart of the same session", { timeout: 60000, skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "todo-real-pi-"));
  mkdirSync(join(root, "agent"));
  const session = join(root, "session.jsonl");
  try {
    const first = pi(root, session);
    assert.match((await first.call({ op: "set", items: ["Frame", "Report"] })).text, /Set 2 items/);
    assert.equal((await first.call({ op: "update", id: 1, state: "done" })).text,
      "Item 1 is done.\nTodo: 1 done, 0 skipped, 0 in progress, 1 pending\n[ ] 2. Report");
    const refused = await first.call({ op: "update", id: 2, state: "skipped" });
    assert.equal(refused.isError, true);
    await first.stop();
    const entries = readFileSync(session, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "custom" && entry.customType === "todo");
    assert.equal(entries.length, 2, "one entry per change, none for the refused skip");
    const second = pi(root, session);
    assert.match((await second.call({ op: "get" })).text, /\[x\] 1\. Frame\n\[ \] 2\. Report/);
    await second.stop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

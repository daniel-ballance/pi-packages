import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { executable } from "../../extensions/antigravity-provider/src/process.js";

const run = promisify(execFile);

test("real default agent reads the file, and Pi records an Antigravity tool card", { timeout: 150_000 }, async t => {
  const binary = executable(process.env);
  assert.ok(binary, "Install agy and sign in before running the live test.");
  const dir = mkdtempSync(join(tmpdir(), "pi-agy-live-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = process.env.PI_ANTIGRAVITY_TRACE ? resolve(process.env.PI_ANTIGRAVITY_TRACE) : join(mkdtempSync(join(tmpdir(), "pi-agy-trace-")), "outgoing.jsonl");
  writeFileSync(trace, "", { mode: 0o600, flag: "wx" });
  t.diagnostic(`Outgoing ACP traffic: ${trace}`);
  const wrapper = join(dir, "agy-trace");
  writeFileSync(wrapper, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (JSON.stringify(args) !== '["acp"]') throw new Error("Expected only agy acp");
const agy = spawn(${JSON.stringify(binary)}, args, { stdio: ["pipe", "inherit", "inherit"] });
process.stdin.on("data", chunk => appendFileSync(${JSON.stringify(trace)}, chunk));
process.stdin.pipe(agy.stdin);
agy.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; });
agy.on("exit", code => { process.exit(code ?? 1); });
`);
  chmodSync(wrapper, 0o700);
  const nonce = randomUUID();
  const input = join(dir, "nonce.txt");
  const session = join(dir, "session.jsonl");
  writeFileSync(input, nonce + "\n");
  const extension = fileURLToPath(new URL("../../extensions/antigravity-provider/index.ts", import.meta.url));
  const request = run(process.env.PI_ANTIGRAVITY_TEST_PI || "pi", [
    "--offline", "--no-extensions", "--no-approve", "--no-context-files", "--no-skills", "--no-mcp", "--session", session,
    "-e", extension, "--model", "antigravity/gemini-3.8-flash", "-p",
    "Use your own read_file tool to read nonce.txt in the working directory. Reply with only the exact nonce from the file.",
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "pi"), PI_ANTIGRAVITY_AGY: wrapper }, timeout: 120_000 });
  request.child.stdin?.end();
  const { stdout, stderr } = await request;
  assert.ok(stdout.includes(nonce), `Pi did not return the nonce: ${stdout}\n${stderr}`);
  const rows = readFileSync(session, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.message?.role === "assistant" && row.message.content.some((block: { type: string; name?: string }) =>
    block.type === "toolCall" && block.name === "antigravity")), "Pi's transcript did not contain an Antigravity card");
  assert.ok(rows.some(row => row.message?.role === "toolResult" && row.message.toolName === "antigravity" && !row.message.isError));
  const frames = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(frames.find(frame => frame.method === "initialize").params.clientInfo.name, "pi");
  const append = frames.find(frame => frame.method === "session/new").params._meta.antigravity.systemPrompt.append;
  assert.match(append, /running in Pi through the Antigravity CLI over ACP, as gemini-3\.8-flash/);
  assert.doesNotMatch(append, /coding assistant running inside pi|Pi documentation|<docs>|<preamble>/i);
});

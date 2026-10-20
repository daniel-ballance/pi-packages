import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  "agent-dir": { type: "string", default: process.env.P3STACK_EVAL_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(here, "fixtures/agent") },
  fixture: { type: "string", default: process.env.P3STACK_EVAL_FIXTURE ?? join(here, "fixtures/project") },
  output: { type: "string", default: join(here, "fixtures/output") },
  model: { type: "string" },
  only: { type: "string" },
  "max-reads": { type: "string", default: "3" },
  "mode-off": { type: "boolean", default: false },
} });
const agentDir = resolve(values["agent-dir"]), fixture = resolve(values.fixture), output = resolve(values.output);
if (agentDir === join(homedir(), ".pi/agent") || fixture.startsWith(join(homedir(), ".pi/agent"))) throw new Error("Use fixture directories, not the live agent directory.");
if (!["auth.json", "models.json"].every(name => existsSync(join(agentDir, name)))) throw new Error(`Copy fixture auth.json and models.json into ${agentDir}, or pass --agent-dir <fixture-agent>.`);
const suite = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8"));
const model = values.model ?? suite.model;
const maxReads = Number(values["max-reads"]);
if (!Number.isInteger(maxReads) || maxReads < 1) throw new Error("--max-reads must be a positive integer.");
const prompts = suite.prompts.filter(row => !values.only || row.id === values.only);
if (!prompts.length) throw new Error(`Unknown prompt ${values.only}`);
mkdirSync(output, { recursive: true });
mkdirSync(fixture, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [resolve(here, "../..")], defaultProjectTrust: "always", enableInstallTelemetry: false }));

function probe(row) {
  return new Promise((done, fail) => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_POLICY", "PI_SUBAGENT_ALLOWED_TOOLS", "PI_SUBAGENT_PEER_FD", "T3_MCP_URL"]) delete env[key];
    const child = spawn("pi", ["--mode", "json", "--no-session", "--model", model, "--tools", "read", "--no-mcp", "--no-context-files", "--offline", "--approve", `/p3stack ${values["mode-off"] ? "off" : "on"}`, row.prompt], { cwd: fixture, env, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "", stdout = "", stderr = "", reason, timer, killTimer;
    const reads = [], successful = new Set(), completed = new Set();
    const stop = why => {
      if (reason) return;
      reason = why;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    timer = setTimeout(() => stop("timeout"), 120000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary).replace(/\r$/, "");
        pending = pending.slice(boundary + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { stop("invalid JSONL"); continue; }
        if (event.type === "tool_execution_start" && event.toolName === "read") {
          reads.push({ id: event.toolCallId, path: event.args.path });
        }
        if (event.type === "tool_execution_end" && event.toolName === "read") {
          completed.add(event.toolCallId);
          if (!event.isError) successful.add(event.toolCallId);
          if (reads.length >= maxReads && reads.slice(0, maxReads).every(read => completed.has(read.id))) stop("read limit");
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      writeFileSync(join(output, `${row.id}.jsonl`), stdout);
      writeFileSync(join(output, `${row.id}.stderr`), stderr);
      const skillsRoot = resolve(here, "../../skills") + "/";
      const observed = reads.slice(0, maxReads).filter(read => /(?:^|\/)(?:SKILL\.md|playbooks\/[^/]+\.md)$/.test(read.path)).map(read => {
        const absolute = resolve(fixture, read.path);
        return absolute.startsWith(skillsRoot) ? absolute.slice(skillsRoot.length) : absolute;
      });
      const passed = reason === "read limit" && reads.slice(0, maxReads).every(read => successful.has(read.id)) && JSON.stringify(observed) === JSON.stringify(row.expected);
      done({ id: row.id, prompt: row.prompt, expected: row.expected, observed, passed, reason, code, signal });
    });
    child.stdin.end();
  });
}

console.log(`Model ${model}`);
console.log("Prompt | Expected first reads | Observed first reads | Result");
const results = [];
for (const row of prompts) {
  const result = await probe(row);
  results.push(result);
  console.log(`${row.prompt} | ${row.expected.join(", ")} | ${result.observed.join(", ") || "none"} | ${result.passed ? "PASS" : `FAIL (${result.reason ?? result.code})`}`);
}
writeFileSync(join(output, "results.json"), JSON.stringify({ model, maxReads, results }, null, 2) + "\n");
const passed = results.filter(row => row.passed).length;
console.log(`${passed}/${results.length}`);
process.exitCode = passed === results.length ? 0 : 1;

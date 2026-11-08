#!/usr/bin/env node
// Tier C behavior eval: runs realistic tasks in fixture repositories with
// p3stack-mode on and off, and grades what the agent did (tool calls, files,
// commands, final reply) rather than what it says it did. Spends tokens.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const SUBSTITUTIONS = { "{{SKIP}}": "skip" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@example.com", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@example.com" } }).toString();

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === ".git" || name === "node_modules") return [];
    return statSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

function copyTree(from, to) {
  for (const path of walk(from)) {
    let text = readFileSync(join(from, path), "utf8");
    for (const [token, value] of Object.entries(SUBSTITUTIONS)) text = text.replaceAll(token, value);
    mkdirSync(dirname(join(to, path)), { recursive: true });
    writeFileSync(join(to, path), text);
  }
}

/** A fresh git repository: base/ committed, change/ left uncommitted. */
export function materialize(fixture, root) {
  const dir = join(here, "fixtures", fixture);
  copyTree(join(dir, "base"), root);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  if (existsSync(join(dir, "change"))) copyTree(join(dir, "change"), root);
}

/** Parses Pi JSON-mode events into the trace the grader reads. */
export function trace(jsonl) {
  const calls = new Map(), order = [];
  let final = "";
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "tool_execution_start") {
      const call = { tool: event.toolName, args: event.args ?? {}, ok: undefined };
      calls.set(event.toolCallId, call);
      order.push(call);
    }
    if (event.type === "tool_execution_end" && calls.has(event.toolCallId)) calls.get(event.toolCallId).ok = !event.isError;
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text.trim()) final = text;
    }
  }
  return { calls: order, final };
}

const argText = call => JSON.stringify(call.args);
const pathOf = call => String(call.args.path ?? call.args.file_path ?? "");
function matches(step, calls) {
  const pattern = new RegExp(step.pattern, "i");
  return calls.findIndex(call =>
    step.kind === "bash" ? call.tool === "bash" && pattern.test(String(call.args.command ?? "")) :
    step.kind === "read" ? call.tool === "read" && pattern.test(pathOf(call)) :
    step.kind === "edit" ? ["edit", "write"].includes(call.tool) && pattern.test(pathOf(call)) :
    step.kind === "tool" ? pattern.test(call.tool) && (!step.args || new RegExp(step.args, "i").test(argText(call))) : false);
}

/** Grades one expectation against the trace and the project directory after the run. */
export function grade(check, { calls, final }, project) {
  switch (check.kind) {
    case "bash": case "read": case "edit": case "tool": return matches(check, calls) >= 0;
    case "final": return new RegExp(check.pattern, "i").test(final);
    case "any": return check.of.some(step => grade(step, { calls, final }, project));
    case "order": {
      const first = matches(check.first, calls), before = matches(check.before, calls);
      return first >= 0 && (before < 0 || first < before);
    }
    case "file": {
      const files = walk(project).filter(path => new RegExp(check.pattern).test(path));
      if (!files.length) return false;
      return files.some(path => {
        const text = readFileSync(join(project, path), "utf8");
        return (!check.contains || text.includes(check.contains)) && (!check.absent || !new RegExp(check.absent).test(text));
      });
    }
    case "command": return spawnSync("bash", ["-c", check.run], { cwd: project, stdio: "ignore", timeout: 120000 }).status === 0;
    default: throw new Error(`Unknown check kind ${check.kind}`);
  }
}

function runPi({ agentDir, project, model, row, arm, timeoutSeconds }) {
  return new Promise(done => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_POLICY", "PI_SUBAGENT_ALLOWED_TOOLS", "PI_SUBAGENT_PEER_FD", "T3_MCP_URL"]) delete env[key];
    const mode = arm === "on" ? `/p3stack on ${row.grant === "autonomous" ? "autonomous" : "default"}` : "/p3stack off";
    const args = ["--mode", "json", "--no-session", "--model", model, "--tools", row.tools, "--no-context-files", "--approve", ...(row.mcp ? [] : ["--no-mcp", "--offline"]), mode, row.prompt];
    const child = spawn("pi", args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); }, timeoutSeconds * 1000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => { clearTimeout(timer); done({ stdout, stderr, code, timedOut }); });
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    "agent-dir": { type: "string", default: process.env.P3STACK_EVAL_AGENT_DIR },
    model: { type: "string" }, only: { type: "string" }, arms: { type: "string", default: "on,off" },
    runs: { type: "string", default: "1" }, output: { type: "string", default: join(here, "output") },
    keep: { type: "boolean", default: false },
  } });
  const agentDir = values["agent-dir"] && resolve(values["agent-dir"]);
  if (!agentDir || agentDir === join(homedir(), ".pi/agent")) throw new Error("Pass --agent-dir <disposable agent directory> holding auth.json, models.json, settings.json, and mcp.json for MCP cases; never the live ~/.pi/agent.");
  if (!["auth.json", "models.json", "settings.json"].every(name => existsSync(join(agentDir, name)))) throw new Error(`${agentDir} needs auth.json, models.json, and settings.json (packages: this p3stack and web-search).`);
  const suite = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
  const model = values.model ?? suite.model, arms = values.arms.split(","), runs = Number(values.runs);
  const rows = suite.cases.filter(row => !values.only || values.only.split(",").includes(row.id));
  if (!rows.length) throw new Error(`Unknown case ${values.only}`);
  mkdirSync(values.output, { recursive: true });
  const results = [];
  for (const row of rows) for (const arm of arms) for (let run = 1; run <= runs; run++) {
    const project = mkdtempSync(join(tmpdir(), `p3stack-behavior-${row.id}-`));
    try {
      materialize(row.fixture, project);
      const started = Date.now();
      const outcome = await runPi({ agentDir, project, model, row, arm, timeoutSeconds: suite.timeoutSeconds });
      const seen = trace(outcome.stdout);
      const checks = row.expect.map(check => ({ id: check.id, passed: grade(check, seen, project) }));
      const name = `${row.id}.${arm}.${run}`;
      writeFileSync(join(values.output, `${name}.jsonl`), outcome.stdout);
      writeFileSync(join(values.output, `${name}.stderr`), outcome.stderr);
      const result = { id: row.id, arm, run, seconds: Math.round((Date.now() - started) / 1000), timedOut: outcome.timedOut, exit: outcome.code, toolCalls: seen.calls.length, checks, score: checks.filter(check => check.passed).length / checks.length };
      results.push(result);
      console.log(`${row.id} [${arm}] run ${run}: ${checks.map(check => `${check.passed ? "+" : "-"}${check.id}`).join(" ")} (${result.seconds}s${outcome.timedOut ? ", timed out" : ""})`);
    } finally {
      if (!values.keep) rmSync(project, { recursive: true, force: true });
    }
  }
  writeFileSync(join(values.output, "results.json"), JSON.stringify({ model, results }, null, 2) + "\n");
  for (const row of rows) {
    const mean = arm => { const own = results.filter(r => r.id === row.id && r.arm === arm); return own.length ? own.reduce((sum, r) => sum + r.score, 0) / own.length : undefined; };
    const on = mean("on"), off = mean("off");
    console.log(`${row.id}: on ${on === undefined ? "-" : (on * 100).toFixed(0) + "%"}, off ${off === undefined ? "-" : (off * 100).toFixed(0) + "%"}${on !== undefined && off !== undefined ? `, delta ${((on - off) * 100).toFixed(0)} points` : ""}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(2); });

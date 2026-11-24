#!/usr/bin/env node
// Tier C behavior eval: runs realistic tasks in fixture repositories with
// p3stack-mode on and off, and grades what the agent did (tool calls, files,
// commands, final reply) rather than what it says it did. Spends tokens.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gitEnv } from "../../generator/git-env.mjs";
import { agentSource, defaultOutput, parseEvent, positiveInteger, receipts, runPi } from "../routing-eval/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUBSTITUTIONS = { "{{SKIP}}": "skip" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...gitEnv(), GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@example.com", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@example.com" } }).toString();

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === ".git" || name === "node_modules") return [];
    return lstatSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
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
  if (fixture === "floor-review") return treeState(root);
}

function treeState(root) {
  return [git(root, "rev-parse", "HEAD"), git(root, "status", "--porcelain", "--ignored", "-uall"), git(root, "diff", "--binary", "--no-ext-diff", "HEAD")].join("\0");
}

function runCheck(command, args, cwd) {
  const env = gitEnv();
  delete env.NODE_TEST_CONTEXT; // node --test otherwise skips discovery inside our own test suite.
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}

function regressionFailsOnOriginal(project) {
  const copy = mkdtempSync(join(tmpdir(), "p3stack-red-"));
  try {
    cpSync(project, copy, { recursive: true, filter: path => ![".git", "node_modules"].includes(path.split("/").at(-1)) });
    // Use the grader's base, not a commit or test selected by the agent.
    if (!lstatSync(join(copy, "src"), { throwIfNoEntry: false })?.isDirectory()) return false;
    const split = "src/split.js";
    rmSync(join(copy, split), { force: true });
    cpSync(join(here, "fixtures/bug-red-first/base", split), join(copy, split));
    const result = runCheck(process.execPath, ["--test", "--test-reporter=tap"], copy);
    return result.status === 1 && /ERR_ASSERTION/.test(result.stdout);
  } finally { rmSync(copy, { recursive: true, force: true }); }
}

/** Parses Pi JSON-mode events into the trace the grader reads. */
export function trace(jsonl) {
  const calls = new Map(), order = [];
  let final = "", position = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    position++;
    if (event.type === "tool_execution_start") {
      const call = { tool: event.toolName, args: event.args ?? {}, start: position, ok: undefined };
      calls.set(event.toolCallId, call);
      order.push(call);
    }
    if (event.type === "tool_execution_end" && calls.has(event.toolCallId)) {
      const call = calls.get(event.toolCallId);
      call.ok = event.isError === false && !event.result?.isError && !event.result?.details?.mcpError;
      if (call.tool === "codemode") {
        call.nested = (event.result?.details?.calls ?? []).filter(c => c.status === "ok").map(c => ({ tool: c.name, args: c.args }));
      }
      call.end = position;
      call.result = event.result?.content?.filter(part => part.type === "text").map(part => part.text).join("\n");
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = (event.message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
      if (text.trim()) final = text;
    }
  }
  if (!position) throw new Error("Empty Pi JSONL stream");
  return { calls: order, final };
}

const argText = call => JSON.stringify(call.args);
const pathOf = call => String(call.args.path ?? call.args.file_path ?? "");
function matches(step, calls) {
  const pattern = new RegExp(step.pattern, "i");
  const toolMatches = c => pattern.test(c.tool) && (!step.args || new RegExp(step.args, "i").test(argText(c)));
  // Expected assertion/floor diagnostics are completed operations, not successful exits.
  const completed = call => step.kind === "bash" && step.diagnostic
    ? call.end !== undefined && new RegExp(step.diagnostic, "i").test(call.result ?? "")
    : call.ok === true;
  return calls.findIndex(call => completed(call) && (!step.result || new RegExp(step.result, "i").test(call.result ?? "")) && (
    step.kind === "bash" ? call.tool === "bash" && pattern.test(String(call.args.command ?? "")) :
    step.kind === "read" ? call.tool === "read" && pattern.test(pathOf(call)) :
    step.kind === "edit" ? ["edit", "write"].includes(call.tool) && pattern.test(pathOf(call)) :
    step.kind === "tool" ? toolMatches(call) || call.nested?.some(toolMatches) : false));
}

/** Grades one expectation against the trace and the project directory after the run. */
export function grade(check, { calls, final }, project, beforeRun) {
  switch (check.kind) {
    case "bash": case "read": case "edit": case "tool": return matches(check, calls) >= 0;
    case "final": return new RegExp(check.pattern, "i").test(final);
    case "any": return check.of.some(step => grade(step, { calls, final }, project, beforeRun));
    case "order": {
      const first = matches(check.first, calls), before = matches(check.before, calls);
      return first >= 0 && before >= 0 && (calls[first].end ?? first) < (calls[before].start ?? before);
    }
    case "file": {
      const files = walk(project).filter(path => new RegExp(check.pattern).test(path));
      if (check.count !== undefined && files.length !== check.count) return false;
      if (check.verifyPrototype) return files.length === 1 && lstatSync(join(project, files[0])).isFile() && runCheck("python3", [join(here, "oracles/prototype.py"), files[0]], project).status === 0;
      if (!check.contains && !check.absent) return check.count !== undefined || files.length > 0;
      return files.some(path => {
        const text = readFileSync(join(project, path), "utf8");
        return (!check.contains || text.includes(check.contains)) && (!check.absent || !new RegExp(check.absent).test(text));
      });
    }
    case "skipped-test": return final.split(/(?<=[.!?])\s+/).some(sentence =>
      /\b(?:skips?|skipped|disabled)\b/i.test(sentence) && /sumAll|sum\.test\.js/i.test(sentence) &&
      /empty[- ](?:list|array|input)|\[\s*\]|sum\.test\.js:13\b/i.test(sentence) &&
      !/(?:\b(?:not|never|nothing|none|no longer|no tests?)\b|n['’]t\b).*?\b(?:skips?|skipped|disabled)\b/is.test(sentence));
    case "unchanged": return beforeRun !== undefined && treeState(project) === beforeRun;
    case "regression": return regressionFailsOnOriginal(project);
    case "oracle": return runCheck(process.execPath, [join(here, "oracles", check.script)], project).status === 0;
    case "command": return runCheck("bash", ["-c", check.run], project).status === 0;
    default: throw new Error(`Unknown check kind ${check.kind}`);
  }
}

export function assess(row, seen, project, beforeRun) {
  const group = expectations => {
    const checks = expectations.map(check => ({ id: check.id, passed: grade(check, seen, project, beforeRun) }));
    return { checks, score: checks.filter(check => check.passed).length / checks.length };
  };
  const outcome = group(row.outcome), process = group(row.process);
  return { outcome, process, passed: outcome.score === 1 };
}

async function main() {
  const { values } = parseArgs({ options: {
    "agent-dir": { type: "string", default: process.env.P3STACK_EVAL_AGENT_DIR },
    model: { type: "string" }, only: { type: "string" }, arms: { type: "string", default: "on,off" },
    runs: { type: "string", default: "1" }, output: { type: "string", default: defaultOutput },
    keep: { type: "boolean", default: false }, "timeout-seconds": { type: "string" },
  } });
  const suite = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
  const model = values.model ?? suite.model, arms = values.arms.split(",");
  if (!model.trim()) throw new Error("--model must not be empty");
  if (arms.some(arm => !["on", "off"].includes(arm)) || new Set(arms).size !== arms.length) throw new Error("Expected distinct --arms on,off, on or off");
  const runs = positiveInteger(values.runs, "--runs");
  const timeoutSeconds = positiveInteger(values["timeout-seconds"] ?? suite.timeoutSeconds, "--timeout-seconds");
  const ids = values.only?.split(",");
  if (ids?.some(id => !suite.cases.some(row => row.id === id))) throw new Error(`Unknown case in ${values.only}`);
  const rows = suite.cases.filter(row => !ids || ids.includes(row.id));
  if (!rows.length) throw new Error("No behavior cases to run");
  const source = agentSource(values["agent-dir"], { settingsRequired: true, mcp: rows.some(row => row.mcp) });
  const output = receipts(values.output, "behavior", source);
  const results = [];
  for (const row of rows) for (const arm of arms) for (let run = 1; run <= runs; run++) {
    const project = mkdtempSync(join(source.scratch, `p3stack-behavior-${row.id}-`));
    try {
      const before = materialize(row.fixture, project);
      const started = Date.now();
      const mode = arm === "on" ? `/p3stack on ${row.grant ?? "default"}` : "/p3stack off";
      const args = ["--mode", "json", "--no-session", "--model", model, "--tools", row.tools, "--no-context-files", "--approve", ...(row.mcp ? [] : ["--no-mcp", "--offline"]), mode, row.prompt];
      const outcome = await runPi({ source, cwd: project, args, timeoutSeconds, mcp: row.mcp, log: join(output, `${row.id}.${arm}.${run}`) });
      const seen = trace(outcome.stdout);
      const scores = assess(row, seen, project, before);
      const result = { id: row.id, arm, run, seconds: Math.round((Date.now() - started) / 1000), project: values.keep ? project : undefined, exit: outcome.code, toolCalls: seen.calls.length, ...scores };
      results.push(result);
      for (const name of ["outcome", "process"]) console.log(`${row.id} [${arm}] run ${run} ${name} ${(scores[name].score * 100).toFixed(0)}%: ${scores[name].checks.map(c => `${c.passed ? "+" : "-"}${c.id}`).join(" ")}`);
    } finally {
      if (!values.keep) rmSync(project, { recursive: true, force: true });
    }
  }
  if (!results.length) throw new Error("No completed behavior runs");
  writeFileSync(join(output, "results.json"), JSON.stringify({ model, results }, null, 2) + "\n");
  for (const row of rows) for (const arm of arms) {
    const own = results.filter(r => r.id === row.id && r.arm === arm);
    const mean = name => (100 * own.reduce((sum, r) => sum + r[name].score, 0) / own.length).toFixed(0);
    console.log(`${row.id} [${arm}]: outcomes ${mean("outcome")}%, process ${mean("process")}%`);
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(2); });

#!/usr/bin/env node
// Tier C behavior eval: runs realistic tasks in fixture repositories with
// p3stack-mode on and off, and grades what the agent did (tool calls, files,
// commands, final reply) rather than what it says it did. Spends tokens.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { onGraderCopy } from "./oracles/copy.mjs";
import { recordAttempt, revision } from "../routing-eval/receipt.mjs";
import { findBrowser } from "./oracles/find-browser.mjs";
import { coverageModules } from "./oracles/coverage.mjs";
import { agentSource, defaultOutput, evalEnv, parseEvent, positiveInteger, receipts } from "../routing-eval/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SUBSTITUTIONS = { "{{SKIP}}": "skip" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...evalEnv(), GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@example.com", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@example.com" } }).toString();

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === ".git" || name === "node_modules") return [];
    return lstatSync(path).isDirectory() ? walk(path, base) : [relative(base, path)];
  });
}

// Snapshot the small fixture as delivered, including untracked work. Never follow an artifact link.
function snapshot(root) {
  return new Map(walk(root).map(path => {
    const file = join(root, path), stat = lstatSync(file);
    if (stat.isSymbolicLink()) return [path, { link: readlinkSync(file) }];
    if (!stat.isFile()) return [path, { omitted: "not a regular file" }];
    return [path, readFileSync(file, "utf8")];
  }));
}
function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path) !== after.get(path))
    .map(path => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
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
  const env = evalEnv();
  delete env.NODE_TEST_CONTEXT; // node --test otherwise skips discovery inside our own test suite.
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}

function regressionFailsOnOriginal(project) {
  return onGraderCopy(project, copy => {
    // Use the grader's base, not a commit or test selected by the agent.
    if (!lstatSync(join(copy, "src"), { throwIfNoEntry: false })?.isDirectory()) return false;
    const split = "src/split.js";
    rmSync(join(copy, split), { force: true });
    cpSync(join(here, "fixtures/bug-red-first/base", split), join(copy, split));
    const result = runCheck(process.execPath, ["--test", "--test-reporter=tap"], copy);
    return result.status === 1 && /ERR_ASSERTION/.test(result.stdout);
  });
}

function emptyListFails(project) {
  return onGraderCopy(project, copy => {
    const file = join(copy, "test/sum.test.js");
    if (!existsSync(file)) return false;
    const suite = readFileSync(file, "utf8");
    const skipped = 'test.skip("sumAll of an empty list is zero"';
    if (!suite.includes(skipped)) return false;
    writeFileSync(file, suite.replace(skipped, skipped.replace(".skip", "")));
    const result = runCheck(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=^sumAll of an empty list is zero$", file], copy);
    return result.status === 1 && /not ok \d+ - sumAll of an empty list is zero\b/.test(result.stdout)
      && /Reduce of empty array with no initial value|ERR_ASSERTION/.test(result.stdout);
  });
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

// A sentence denies the skip when a negation governs the skip verb itself ("is not, in fact, skipped",
// "is not marked as skipped"), or when a negative subject with no verb of its own is said to be skipped
// ("None of the empty-list tests are skipped"). A negation of something else does not count
// ("can't run because it is skipped").
const DENIED_VERB = /(?:\b(?:not|never|no longer)\b|n['’]t\b)(?:\s*,?\s+(?:\w+ly|ever|in fact|actually)\b,?)*\s+(?:(?:be(?:en|ing)?|get(?:ting)?|use|marked(?:\s+as)?)\s+)*`?(?:(?:test|it)\.)?(?:skips?|skipped|disabled)\b/i;
const NEGATIVE_SUBJECT = /\b(?:nothing|none|no)\b((?:\s+[^\s]+){0,9}?)\s+(?:is|are|was|were)\s+(?:(?:\w+ly|ever)\s+)?(?:skipped|disabled)\b/gi;
const CLAUSE_WORD = /^(?:is|are|was|were|can|could|does|do|did|has|have|had|fix\w*|explain\w*|covers?|runs?|skips?|means?|because|since|so|but|why|while|when|that|which)$/i;
function deniesSkip(sentence) {
  if (DENIED_VERB.test(sentence)) return true;
  for (const [, subject] of sentence.matchAll(NEGATIVE_SUBJECT)) {
    if (!subject.trim().split(/\s+/).filter(Boolean).some(word => CLAUSE_WORD.test(word.replace(/[^\w]/g, "")))) return true;
  }
  return false;
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
      if (check.verifyPrototype || check.verifyArithmetic) {
        if (files.length !== 1 || !lstatSync(join(project, files[0])).isFile()) return false;
        // Drive the page in a browser when one is installed; exit 3 means none could be driven.
        const driven = runCheck(process.execPath, [join(here, "oracles/prototype-browser.mjs"), files[0], ...(check.verifyArithmetic ? ["--arithmetic"] : [])], project).status;
        if (driven === 0 || driven === 1) return driven === 0;
        if (driven === 4 && check.verifyArithmetic) return null;
        if (driven !== 3) throw new Error(`Prototype browser grader exited ${driven}`);
        if (check.verifyArithmetic) throw new Error("No browser could be driven to verify refund arithmetic");
        console.warn("prototype check: no browser could be driven; fell back to the structural check");
        return runCheck("python3", [join(here, "oracles/prototype.py"), files[0]], project).status === 0;
      }
      if (!check.contains && !check.absent) return check.count !== undefined || files.length > 0;
      return files.some(path => {
        const text = readFileSync(join(project, path), "utf8");
        return (!check.contains || text.includes(check.contains)) && (!check.absent || !new RegExp(check.absent).test(text));
      });
    }
    case "skipped-test": return final.split(/(?<=[.!?])\s+/).some(sentence =>
      /\b(?:skips?|skipped|disabled)\b/i.test(sentence) && /sumAll|sum\.test\.js/i.test(sentence) &&
      /empty[- ](?:list|array|input)|\[\s*\]|sum\.test\.js:13\b/i.test(sentence) &&
      !deniesSkip(sentence)) && emptyListFails(project);
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
    const measured = checks.filter(c => c.passed !== null);
    return { checks, score: measured.length ? measured.filter(c => c.passed).length / measured.length : null };
  };
  const outcome = group(row.outcome), process = group(row.process);
  const passed = outcome.checks.some(c => c.passed === false) ? false : outcome.checks.some(c => c.passed === null) ? null : true;
  return { outcome, process, passed };
}

const percent = score => score === null ? "not graded" : (score * 100).toFixed(0) + "%";

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
  if (rows.some(row => row.fixture === "source-grounding")) coverageModules();
  if (rows.some(row => row.outcome.some(check => check.verifyArithmetic)) && !findBrowser()) {
    throw new Error("Refund arithmetic requires Chromium on PATH or P3STACK_EVAL_CHROMIUM");
  }
  const output = receipts(values.output, "behavior", source);
  const results = [], checkout = revision();
  for (const row of rows) for (const arm of arms) for (let run = 1; run <= runs; run++) {
    const project = mkdtempSync(join(source.scratch, `p3stack-behavior-${row.id}-`));
    try {
      const before = materialize(row.fixture, project), initial = snapshot(project);
      const started = Date.now();
      const mode = arm === "on" ? `/p3stack on ${row.grant ?? "default"}` : "/p3stack off";
      const args = ["--mode", "json", "--no-session", "--model", model, "--tools", row.tools, "--no-context-files", "--approve", ...(row.mcp ? [] : ["--no-mcp", "--offline"]), mode, row.prompt];
      const result = await recordAttempt({ checkout, tier: "behavior", row, arm, run,
        pi: { source, cwd: project, args, timeoutSeconds, mcp: row.mcp, log: join(output, `${row.id}.${arm}.${run}`) },
        grade(outcome) {
          const seen = trace(outcome.stdout);
          return { id: row.id, arm, run, seconds: Math.round((Date.now() - started) / 1000), exit: outcome.code, toolCalls: seen.calls.length, ...assess(row, seen, project, before) };
        },
        artifact: final => ({ final, changes: changedFiles(initial, snapshot(project)) }),
      });
      results.push(result);
      writeFileSync(join(output, "results.json"), JSON.stringify({ model, results }, null, 2) + "\n");
      for (const name of ["outcome", "process"]) console.log(`${row.id} [${arm}] run ${run} ${name} ${percent(result[name].score)}: ${result[name].checks.map(c => `${c.passed === null ? "?" : c.passed ? "+" : "-"}${c.id}`).join(" ")}`);
    } finally {
      if (values.keep) console.log(`Kept project: ${project}`);
      else rmSync(project, { recursive: true, force: true });
    }
  }
  if (!results.length) throw new Error("No completed behavior runs");
  for (const row of rows) for (const arm of arms) {
    const own = results.filter(r => r.id === row.id && r.arm === arm);
    const mean = name => {
      const measured = own.map(r => r[name].score).filter(score => score !== null);
      return percent(measured.length ? measured.reduce((sum, score) => sum + score, 0) / measured.length : null);
    };
    const arithmetic = row.outcome.find(check => check.verifyArithmetic);
    const notGraded = arithmetic ? own.filter(r => r.outcome.checks.some(c => c.id === arithmetic.id && c.passed === null)).length : 0;
    console.log(`${row.id} [${arm}]: outcomes ${mean("outcome")}, process ${mean("process")}${arithmetic ? `, arithmetic not graded: ${notGraded}/${own.length}` : ""}`);
  }
  if (results.some(result => result.passed === false)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exit(2); });

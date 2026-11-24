import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentSource, defaultOutput, pkg, positiveInteger, receipts, safePath } from "./harness.mjs";
import { recordAttempt, revision, skillPaths, skillRoots } from "./receipt.mjs";
import { readSequence } from "./reads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
async function main() {
  const { values } = parseArgs({ options: {
    "agent-dir": { type: "string", default: process.env.P3STACK_EVAL_AGENT_DIR },
    fixture: { type: "string", default: process.env.P3STACK_EVAL_FIXTURE ?? join(here, "fixtures/project") },
    output: { type: "string", default: defaultOutput }, model: { type: "string" }, only: { type: "string" },
    suite: { type: "string", default: join(here, "prompts.json") },
    "max-reads": { type: "string", default: "3" }, "mode-off": { type: "boolean", default: false },
    runs: { type: "string" }, "min-rate": { type: "string" }, "timeout-seconds": { type: "string", default: "120" },
  } });
  const suite = JSON.parse(readFileSync(values.suite, "utf8"));
  // A suite with "arm": "off" grades discovery with routing off: which skill a model opens from its description alone.
  const discovery = suite.arm === "off", modeOff = values["mode-off"] || discovery, graded = !modeOff || discovery;
  const model = values.model ?? suite.model;
  if (!model.trim()) throw new Error("--model must not be empty");
  const maxReads = positiveInteger(values["max-reads"], "--max-reads"), runs = positiveInteger(values.runs ?? suite.runs, "--runs");
  const timeoutSeconds = positiveInteger(values["timeout-seconds"], "--timeout-seconds");
  const minRate = Number(values["min-rate"] ?? suite.minRate);
  if (!(minRate > 0 && minRate <= 1)) throw new Error("--min-rate must be in (0, 1].");
  const prompts = suite.prompts.filter(row => values.only === undefined || row.id === values.only);
  if (!prompts.length) throw new Error(`Unknown prompt or empty suite: ${values.only}`);
  const source = agentSource(values["agent-dir"]), fixture = safePath(values.fixture, source.dir);
  if (!statSync(fixture).isDirectory()) throw new Error(`Not a fixture directory: ${fixture}`);
  const output = receipts(values.output, "routing", source);
  console.log(`Model ${model}, ${runs} run(s) per prompt; ${!graded ? "mode off (not graded)" : `${modeOff ? "mode off, " : ""}pass at ${Math.round(minRate * 100)}% or more`}`);

  const results = [], checkout = revision(), paths = skillPaths();
  const publicPath = path => paths.has(path) ? path : "<other>";
  for (const row of prompts) {
    const attempts = [], expected = graded ? row.expected : undefined;
    const mode = modeOff ? "off" : row.grant ? `on ${row.grant}` : "on";
    const args = ["--mode", "json", "--no-session", "--model", model, "--tools", "read", "--no-mcp", "--no-context-files", "--offline", "--approve", `/p3stack ${mode}`, row.prompt];
    for (let run = 1; run <= runs; run++) {
      const probe = readSequence(fixture, skillRoots.map(root => join(pkg, root)), Math.max(maxReads, expected?.length ?? 0));
      const reads = () => probe.reads.map(({ path, start, end, ok, offset, limit }) => ({ path: publicPath(path), start, end, ok,
        offset: Number.isSafeInteger(offset) ? offset : undefined, limit: Number.isSafeInteger(limit) ? limit : undefined }));
      attempts.push(await recordAttempt({ checkout, tier: "routing", row, arm: modeOff ? "off" : "on", run,
        pi: { source, cwd: fixture, args, timeoutSeconds, log: join(output, `${row.id}.${run}`), onEvent: probe.record },
        grade: ({ reason, code, signal }) => ({ observed: probe.observed().map(publicPath), reads: reads(), passed: graded ? probe.matches(expected, row.absent, row.none === true) : undefined, reason, code, signal }),
        artifact: () => ({ reads: reads(), expected, absent: row.absent, none: row.none }),
      }));
    }
    const result = { id: row.id, prompt: row.prompt, runs, expected, attempts };
    if (graded) {
      result.passedRuns = attempts.filter(a => a.passed).length;
      result.rate = result.passedRuns / runs;
      result.passed = result.rate >= minRate;
    }
    console.log(`${row.id}: ${!graded ? "not graded" : `${result.passedRuns}/${runs} ${result.passed ? "PASS" : "FAIL"}`} | ${attempts.map(a => a.observed.join(", ") || "no routing reads").join("; ")}`);
    results.push(result);
  }
  if (!results.length) throw new Error("No completed routing runs");
  writeFileSync(join(output, "results.json"), JSON.stringify({ model, modeOff, suite: basename(values.suite), maxReads, runs, minRate: graded ? minRate : undefined, results }, null, 2) + "\n");
  if (!graded) return;
  const passed = results.filter(r => r.passed).length;
  const overall = results.reduce((sum, r) => sum + r.passedRuns, 0) / (results.length * runs);
  console.log(`${passed}/${results.length} prompts pass; ${(overall * 100).toFixed(1)}% of all runs routed as expected`);
  if (passed !== results.length) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 2; });

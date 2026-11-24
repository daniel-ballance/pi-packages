import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentSource, defaultOutput, pkg, positiveInteger, receipts, runPi, safePath } from "./harness.mjs";
import { readSequence } from "./reads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
async function main() {
  const { values } = parseArgs({ options: {
    "agent-dir": { type: "string", default: process.env.P3STACK_EVAL_AGENT_DIR },
    fixture: { type: "string", default: process.env.P3STACK_EVAL_FIXTURE ?? join(here, "fixtures/project") },
    output: { type: "string", default: defaultOutput }, model: { type: "string" }, only: { type: "string" },
    "max-reads": { type: "string", default: "3" }, "mode-off": { type: "boolean", default: false },
    runs: { type: "string" }, "min-rate": { type: "string" }, "timeout-seconds": { type: "string", default: "120" },
  } });
  const suite = JSON.parse(readFileSync(join(here, "prompts.json"), "utf8"));
  const model = values.model ?? suite.model, modeOff = values["mode-off"];
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
  console.log(`Model ${model}, ${runs} run(s) per prompt; ${modeOff ? "mode off (not graded)" : `pass at ${Math.round(minRate * 100)}% or more`}`);

  const results = [];
  for (const row of prompts) {
    const attempts = [], expected = modeOff ? undefined : row.expected;
    const mode = modeOff ? "off" : row.grant ? `on ${row.grant}` : "on";
    const args = ["--mode", "json", "--no-session", "--model", model, "--tools", "read", "--no-mcp", "--no-context-files", "--offline", "--approve", `/p3stack ${mode}`, row.prompt];
    for (let run = 1; run <= runs; run++) {
      const probe = readSequence(fixture, join(pkg, "skills"), Math.max(maxReads, expected?.length ?? 0));
      const { reason, code, signal } = await runPi({ source, cwd: fixture, args, timeoutSeconds, log: join(output, `${row.id}.${run}`), onEvent: probe.record });
      attempts.push({ observed: probe.observed(), reads: probe.reads, passed: modeOff ? undefined : probe.matches(expected, row.absent), reason, code, signal });
    }
    const result = { id: row.id, prompt: row.prompt, runs, expected, attempts };
    if (!modeOff) {
      result.passedRuns = attempts.filter(a => a.passed).length;
      result.rate = result.passedRuns / runs;
      result.passed = result.rate >= minRate;
    }
    console.log(`${row.id}: ${modeOff ? "not graded" : `${result.passedRuns}/${runs} ${result.passed ? "PASS" : "FAIL"}`} | ${attempts.map(a => a.observed.join(", ") || "no routing reads").join("; ")}`);
    results.push(result);
  }
  if (!results.length) throw new Error("No completed routing runs");
  writeFileSync(join(output, "results.json"), JSON.stringify({ model, modeOff, maxReads, runs, minRate: modeOff ? undefined : minRate, results }, null, 2) + "\n");
  if (modeOff) return;
  const passed = results.filter(r => r.passed).length;
  const overall = results.reduce((sum, r) => sum + r.passedRuns, 0) / (results.length * runs);
  console.log(`${passed}/${results.length} prompts pass; ${(overall * 100).toFixed(1)}% of all runs routed as expected`);
  if (passed !== results.length) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 2; });

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { evalEnv, pkg, runPi } from "./harness.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = data => JSON.stringify(data, null, 2) + "\n";
const git = (...args) => execFileSync("git", args, { cwd: pkg, env: evalEnv(), encoding: "utf8" });
export const revision = () => ({ revision: git("rev-parse", "HEAD").trim(), dirty: !!git("status", "--porcelain") });
// Paths relative to their skills root: p3stack's own skills and the nested subagents skills Pi also lists.
export const skillRoots = ["skills", "subagents/skills"];
export const skillPaths = () => new Set(skillRoots.flatMap(root =>
  git("ls-files", "-z", root).split("\0").filter(Boolean).map(p => p.slice(root.length + 1))));

// Copy identifiers, never arbitrary message fields, deltas, config, response IDs or tool arguments.
// A missing model/effort/usage stays unknown; the command-line request is not an observation.
function identityFilter(source) {
  const privateIds = new Set();
  try {
    JSON.parse(readFileSync(join(source.dir, "auth.json")), (key, value) => {
      if (key !== "type" && typeof value === "string" && value.length) privateIds.add(value);
      return value;
    });
  } catch { throw new Error("Cannot read eval auth.json as JSON"); }
  return { privateIds, identifier(value) {
    return typeof value === "string" && /^[\w.-]+(?:\/[\w.:-]+)?$/.test(value) &&
      ![...privateIds].some(id => value === id || (id.length >= 8 && value.includes(id))) ? value : null;
  } };
}
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
export async function recordAttempt({ checkout, tier, row, arm, run, pi, grade, artifact }) {
  const start = performance.now(), models = new Map();
  const usage = Object.fromEntries(usageKeys.map(k => [k, 0]));
  const { privateIds, identifier } = identityFilter(pi.source);
  let turns = 0, missingUsage = false, final = "", outcome, result;
  const file = `${pi.log}.receipt.json`;
  try {
    outcome = await runPi({ ...pi, onEvent(event) {
      if (event.type === "session" && typeof event.id === "string") privateIds.add(event.id);
      const m = event.message;
      if (event.type === "message_end" && m?.role === "assistant") {
        turns++;
        const model = Object.fromEntries(["provider", "model", "responseModel", "thinkingLevel", "providerThinkingLevel"].map(k => [k, identifier(m[k])]));
        models.set(JSON.stringify(model), model);
        if (usageKeys.every(k => Number.isSafeInteger(m.usage?.[k]) && m.usage[k] >= 0)) {
          for (const k of usageKeys) usage[k] += m.usage[k];
        } else missingUsage = true;
        const text = m.content?.filter(c => c.type === "text").map(c => c.text).join("\n");
        if (text?.trim()) final = text;
      }
      return pi.onEvent?.(event);
    } });
    result = grade(outcome);
    return { ...result, receipt: basename(file) };
  } catch (error) {
    outcome ??= { code: error.exit, signal: error.signal, reason: error.reason, piVersion: error.piVersion };
    throw error;
  } finally {
    // The artifact is private work product; only its relative name and digest go in the receipt.
    const work = `${pi.log}.artifact.json`, bytes = json(artifact(final));
    writeFileSync(work, bytes, { mode: 0o600 });
    writeFileSync(file, json({ ...checkout, tier, id: row.id, arm, grant: arm === "on" ? row.grant ?? "default" : null, run,
      host: "terminal", piVersion: outcome?.piVersion ?? null, promptSha256: hash(row.prompt),
      models: [...models.values()], turns, usage: turns && !missingUsage ? usage : null,
      elapsedMs: Math.round(performance.now() - start), reason: outcome?.reason ?? "invalid", exit: outcome?.code ?? null, signal: outcome?.signal ?? null,
      status: !result ? "invalid" : result.passed == null ? "not graded" : result.passed ? "passed" : "failed",
      passed: result?.passed ?? null, outcome: result?.outcome, process: result?.process,
      artifact: { private: true, file: basename(work), sha256: hash(bytes) },
    }), { mode: 0o600 });
  }
}

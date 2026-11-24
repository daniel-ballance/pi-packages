// Shared boundary of the two paid evals. The named agent directory is input, never scratch space.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Unlike the generator, eval children must inherit neither Git selectors nor config/trace destinations.
export const evalEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

export const pkg = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
export const defaultOutput = join(pkg, "test/eval-output");
export function positiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

// Canonicalize the existing prefix even for a not-yet-created output directory.
function canonical(path) {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
  return join(canonical(dirname(path)), basename(path));
}
export function safePath(path, source) {
  if (!path?.trim()) throw new Error("Expected a non-empty directory path");
  const real = p => canonical(resolve(p.replace(/^~(?=\/|$)/, homedir())));
  const absolute = real(path);
  const inside = dir => absolute === dir || absolute.startsWith(dir + sep);
  for (const dir of [join(homedir(), ".pi/agent"), process.env.PI_CODING_AGENT_DIR].filter(Boolean)) {
    if (inside(real(dir))) throw new Error(`Refusing live agent directory: ${absolute}`);
  }
  if (source && inside(source)) throw new Error(`Refusing to write inside the eval input: ${source}`);
  return absolute;
}

export function agentSource(path, { settingsRequired = false, mcp = false } = {}) {
  if (!path) throw new Error("Pass --agent-dir <disposable credential/config source>");
  const dir = safePath(path), required = ["auth.json", "models.json"];
  if (settingsRequired) required.push("settings.json");
  if (mcp) required.push("mcp.json");
  for (const file of required) if (!statSync(join(dir, file), { throwIfNoEntry: false })?.isFile()) throw new Error(`${dir} needs ${file}`);
  const settingsFile = join(dir, "settings.json");
  const source = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  // Relative package/provider paths resolve against the source settings, not /tmp.
  const qualify = spec => /^(?:\w+:|\/|~)/.test(spec) ? spec : resolve(dir, spec);
  const packages = (source.packages ?? []).map(p => typeof p === "string" ? qualify(p) : { ...p, source: qualify(p.source) });
  if (!packages.some(p => (p.source ?? p) === pkg)) packages.push(pkg);
  const settings = { packages, extensions: source.extensions?.map(qualify), defaultProjectTrust: "always", enableInstallTelemetry: false };
  return { dir, settings, scratch: safePath(tmpdir(), dir) };
}

export function receipts(path, tier, source) {
  const base = safePath(path, source.dir);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(base, `${tier}-`));
  console.log(`Receipts: ${output}`);
  return output;
}

export function parseEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { throw new Error("Invalid Pi JSONL record"); }
  if (!event || typeof event.type !== "string") throw new Error("Invalid Pi JSONL event: missing type");
  if (["tool_execution_start", "tool_execution_end"].includes(event.type) && !event.toolCallId) throw new Error("Invalid Pi JSONL tool call: missing id");
  return event;
}

export async function runPi({ source, mcp, cwd, args, timeoutSeconds, log, onEvent }) {
  if (timeoutSeconds > 2147483) throw new Error("--timeout-seconds exceeds the timer limit");
  const dir = mkdtempSync(join(source.scratch, "p3stack-eval-agent-"));
  const interruption = new AbortController();
  const interrupt = signal => interruption.abort(signal);
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) process.on(signal, interrupt);
  try {
    for (const name of ["auth.json", "models.json", ...(mcp ? ["mcp.json"] : [])]) copyFileSync(join(source.dir, name), join(dir, name));
    writeFileSync(join(dir, "settings.json"), JSON.stringify(source.settings), { mode: 0o600 });
    const env = { ...evalEnv(), PI_CODING_AGENT_DIR: dir };
    for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_POLICY", "PI_SUBAGENT_ALLOWED_TOOLS", "PI_SUBAGENT_PEER_FD", "T3_MCP_URL"]) delete env[key];
    return await capture({ cwd, env, args, timeoutSeconds, log, onEvent, interruption: interruption.signal });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const signal of signals) process.off(signal, interrupt);
    if (interruption.signal.aborted) process.kill(process.pid, interruption.signal.reason);
  }
}

function capture({ cwd, env, args, timeoutSeconds, log, onEvent, interruption }) {
  return new Promise((done, fail) => {
    const child = spawn("pi", args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", tail = "", reason, error, killTimer, settled = false, worked = false, modelError;
    const active = new Set();
    const signalGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (e) { if (e.code !== "ESRCH") error = e; }
    };
    const hardStop = () => {
      signalGroup("SIGKILL");
      // A descendant can keep a pipe open even after the leader exits.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const stop = (why, signal = "SIGTERM") => {
      if (reason && why !== "interrupt") return;
      reason = why;
      if (why === "timeout") hardStop();
      else {
        signalGroup(signal);
        clearTimeout(killTimer);
        killTimer = setTimeout(hardStop, 2000);
      }
    };
    interruption.addEventListener("abort", () => stop("interrupt", interruption.reason), { once: true });
    const timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
    const record = line => {
      if (!line.trim() || error) return;
      try {
        const event = parseEvent(line);
        if (event.type === "agent_start") settled = false;
        if (event.type === "agent_settled") settled = event.aborted === false;
        if (event.type === "tool_execution_start") active.add(event.toolCallId);
        if (event.type === "tool_execution_end" && active.delete(event.toolCallId)) worked = true;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          if (event.message.content?.some(p => p.type === "text" && p.text?.trim())) worked = true;
          modelError = ["aborted", "error"].includes(event.message.stopReason) ? event.message.stopReason : undefined;
        }
        if (onEvent?.(event)) stop("read limit");
      } catch (e) { error = e; stop("invalid stream"); }
    };
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      const lines = (tail + chunk).split("\n");
      tail = lines.pop();
      for (const line of lines) record(line);
    });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", e => { error = e; }); // close follows error even for ENOENT
    child.once("close", (code, signal) => {
      record(tail);
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (reason && reason !== "timeout") signalGroup("SIGKILL"); // Also stop helpers that already closed their pipes.
      try {
        writeFileSync(`${log}.jsonl`, stdout, { mode: 0o600 });
        writeFileSync(`${log}.stderr`, stderr, { mode: 0o600 });
        if (error) throw error;
        if (reason === "timeout") throw new Error(`Pi timed out after ${timeoutSeconds}s`);
        const capped = reason === "read limit";
        // Pi traps our SIGTERM, disposes its runtime, and exits 143.
        if (code !== 0 && !(capped && (code === 143 || ["SIGTERM", "SIGKILL"].includes(signal)))) throw new Error(`Pi exited ${code ?? signal}`);
        if (!worked || ((!settled || active.size) && !capped) || modelError) throw new Error(`No completed Pi run (${modelError ?? "empty or incomplete event stream"})`);
        done({ stdout, reason: reason ?? "completed", code, signal });
      } catch (e) { fail(new Error(`${e.message} (log: ${log})`)); }
    });
  });
}

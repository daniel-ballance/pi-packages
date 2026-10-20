import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Pi's event and SDK message shapes are not worth modelling here; the tests read only the fields they assert on. */
export type Loose = any;

/** Use a full provider/model id to repeat the suite on another subscription model. */
export const MODEL = process.env.CS_LIVE_MODEL ?? "claude-subscription/claude-haiku-5-5";

const EXTENSION = fileURLToPath(new URL("../../extensions/claude-subscription/index.ts", import.meta.url));
const RECORDER = fileURLToPath(new URL("./record-sdk-messages.ts", import.meta.url));

/** How long one Pi run, or one turn in a long-lived Pi, may take before the test gives up. */
export const TURN_TIMEOUT_MS = 90_000;

/**
 * The environment a child Pi gets: the caller's, minus Claude and Anthropic variables
 * that would reroute or reconfigure Claude Code (a parent agent harness sets many).
 * The two that carry the login stay.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC)/.test(name) && !keep.has(name)) continue;
    // Set by `node --test` for its own workers; a child Pi has no use for it.
    if (name.startsWith("NODE_TEST_")) continue;
    env[name] = value;
  }
  env.PI_SKIP_VERSION_CHECK = "1";
  return { ...env, ...extra };
}

/**
 * The Pi to drive: `PI_BIN` if set, else the first `pi` on PATH. Running through `npm run`
 * puts this package's node_modules/.bin first on PATH, and that holds the older Pi the package
 * is typechecked against, not the one installed for the owner; those directories are skipped.
 */
function findPi(): string | undefined {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir.split(sep).slice(-2).join("/") === "node_modules/.bin") continue;
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export const PI = findPi() ?? "pi";

/** Why the suite cannot run here, or undefined when it can. */
export function unavailable(): string | undefined {
  const pi = spawnSync(PI, ["--version"], { encoding: "utf8", env: childEnv() });
  if (pi.error || pi.status !== 0) return "the `pi` binary is not on PATH (set PI_BIN to point at one)";

  // The SDK carries its own Claude Code, so a `claude` on PATH is optional; when it is there,
  // it can say what kind of login there is. Without it, the provider's own model list is the
  // evidence: it appears only once Claude Code has a login.
  const claude = spawnSync("claude", ["auth", "status"], { encoding: "utf8", env: childEnv() });
  if (!claude.error) {
    try {
      const status: Loose = JSON.parse(claude.stdout);
      if (!status.loggedIn) return "Claude Code is not signed in (run `claude auth login`)";
      if (!status.subscriptionType) return "Claude Code is signed in, but not with a Claude subscription";
    } catch {
      // An unreadable status is not proof of anything; the model list below decides.
    }
  }
  const probe = new Workspace();
  const listed = spawnSync(PI, [...providerArgs(), "--list-models", "claude-subscription"], { encoding: "utf8", env: probe.env() });
  probe.remove();
  if (!/claude-haiku-5-5/.test(listed.stdout)) return "Pi lists no claude-subscription models, so Claude Code has no usable login";
  return undefined;
}

/** Loads the extension under test and keeps the user's own Pi resources out of the run. */
function providerArgs(): string[] {
  return ["--no-extensions", "-e", EXTENSION, "-e", RECORDER, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp"];
}

/** A throwaway project directory, Pi configuration directory and SDK message log. */
export class Workspace {
  readonly root = mkdtempSync(join(tmpdir(), "cs-live-"));
  readonly project = join(this.root, "project");
  readonly agentDir = join(this.root, "agent");
  readonly sessionDir = join(this.root, "sessions");
  readonly sdkLog = join(this.root, "sdk-messages.jsonl");

  constructor(files: Record<string, string> = {}) {
    for (const dir of [this.project, this.agentDir, this.sessionDir]) mkdirSync(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(this.project, name), content);
  }

  /** Every raw SDK message the provider streamed, in order. */
  sdkMessages(): Loose[] {
    if (!existsSync(this.sdkLog)) return [];
    return readFileSync(this.sdkLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  /** The ids of the Claude Code processes that served the run: one `init` message per process. */
  claudeSessionIds(): string[] {
    const ids = this.sdkMessages().filter(m => m.type === "system" && m.subtype === "init").map(m => String(m.session_id));
    return [...new Set(ids)];
  }

  /** Loads the extension under test, with nothing else of the user's. */
  extensionArgs(...rest: string[]): string[] {
    return [...providerArgs(), ...rest];
  }

  /** The extension plus Haiku 5.5. */
  piArgs(...rest: string[]): string[] {
    return this.extensionArgs("--model", MODEL, ...rest);
  }

  env(): NodeJS.ProcessEnv {
    return childEnv({ PI_CODING_AGENT_DIR: this.agentDir, CS_LIVE_SDK_LOG: this.sdkLog });
  }

  remove(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export interface PiRun {
  code: number | null;
  events: Loose[];
  stdout: string;
  stderr: string;
}

/** Runs `pi --mode json -p <prompt>` to completion. */
export function runPi(ws: Workspace, args: string[], prompt: string): Promise<PiRun> {
  return runPiRaw(ws, [...args, "--mode", "json", "-p", prompt]);
}

/** Runs pi with exactly these arguments to completion. Standard input is closed, as print mode needs. */
export function runPiRaw(ws: Workspace, args: string[]): Promise<PiRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, args, { cwd: ws.project, env: ws.env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pi did not finish within ${TURN_TIMEOUT_MS / 1000}s\nstderr: ${stderr.slice(-2000)}`));
    }, TURN_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, events: parseLines(stdout), stdout, stderr });
    });
  });
}

function parseLines(text: string): Loose[] {
  return text.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
}

/** A long-lived `pi --mode rpc` process that takes several prompts and an abort. */
export class RpcPi {
  readonly events: Loose[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Set<() => void>();
  private pending = "";
  private stderr = "";
  private nextId = 1;
  private exited = false;

  constructor(ws: Workspace, args: string[]) {
    this.child = spawn(PI, [...args, "--mode", "rpc"], { cwd: ws.project, env: ws.env(), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.pending += chunk;
      for (let end = this.pending.indexOf("\n"); end >= 0; end = this.pending.indexOf("\n")) {
        const line = this.pending.slice(0, end).replace(/\r$/, "");
        this.pending = this.pending.slice(end + 1);
        if (line.startsWith("{")) this.events.push(JSON.parse(line));
      }
      this.wake();
    });
    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
    this.child.on("close", () => { this.exited = true; this.wake(); });
  }

  private wake(): void {
    for (const listener of [...this.waiting]) listener();
  }

  /** Resolves with the first event at or after `from` that satisfies `match`. */
  async until(match: (event: Loose) => boolean, from: number, what: string): Promise<Loose> {
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    for (;;) {
      const found = this.events.slice(from).find(match);
      if (found) return found;
      if (this.exited) throw new Error(`pi exited while waiting for ${what}\nstderr: ${this.stderr.slice(-2000)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}\nlast events: ${this.events.slice(-5).map(e => e.type).join(", ")}\nstderr: ${this.stderr.slice(-2000)}`);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.waiting.delete(done); resolve(); };
        const timer = setTimeout(done, left);
        this.waiting.add(done);
      });
    }
  }

  /** Sends one command and returns its response record. */
  async command(command: Record<string, unknown>): Promise<Loose> {
    const id = `c${this.nextId++}`;
    const from = this.events.length;
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return this.until(event => event.type === "response" && event.id === id, from, `the response to ${String(command.type)}`);
  }

  /** Sends a prompt and returns the events of the run once Pi has settled. */
  async prompt(message: string): Promise<Loose[]> {
    const from = this.events.length;
    const response = await this.command({ type: "prompt", message });
    if (!response.success) throw new Error(`prompt rejected: ${JSON.stringify(response)}`);
    await this.until(event => event.type === "agent_settled", from, "agent_settled");
    return this.events.slice(from);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const closed = new Promise<void>(resolve => this.child.once("close", () => resolve()));
    const forced = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    this.child.kill("SIGTERM");
    await closed;
    clearTimeout(forced);
  }
}

// Reading Pi's events.

export function assistantMessages(events: Loose[]): Loose[] {
  return events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message);
}

export function textOf(message: Loose | undefined): string {
  return (message?.content ?? []).filter((block: Loose) => block.type === "text").map((block: Loose) => block.text).join("");
}

export function toolCallsOf(message: Loose): Loose[] {
  return (message?.content ?? []).filter((block: Loose) => block.type === "toolCall");
}

/** The text of the last assistant message of a run: the answer. */
export function answerOf(events: Loose[]): string {
  return textOf(assistantMessages(events).at(-1));
}

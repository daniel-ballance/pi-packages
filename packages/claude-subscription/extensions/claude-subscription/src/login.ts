import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApiKeyAuth,
  ApiKeyCredential,
  AuthContext,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { Inbox, loadQuery, subscriptionEnv } from "./sdk.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * A Claude Code process started for `claude auth login`.
 * `output` is stdout. Cancelling must make `kill` end the process and `output`.
 */
export interface ClaudeLoginProcess {
  output: AsyncIterable<string>;
  write(text: string): void;
  kill(): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr(): string;
}

export interface ClaudeLoginDependencies {
  env?: NodeJS.ProcessEnv;
  /** Defaults to this machine. Tests pass `"darwin"` to cover the Keychain sign. */
  platform?: NodeJS.Platform;
  executable?(): string;
  spawn?(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): ClaudeLoginProcess;
  /** The signed-in account, without sending a prompt. Tests script this; the default asks the SDK. */
  account?(signal: AbortSignal): Promise<AccountInfo | undefined>;
}

/**
 * Where a Claude Code login is already visible.
 * Order: `CLAUDE_CODE_OAUTH_TOKEN` (a stored provider env counts the same as the process env),
 * then `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json`, then on macOS `~/.claude.json`.
 */
export async function loginSource(
  ctx: AuthContext,
  credential?: ApiKeyCredential,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (credential?.env?.CLAUDE_CODE_OAUTH_TOKEN || await ctx.env("CLAUDE_CODE_OAUTH_TOKEN")) return "CLAUDE_CODE_OAUTH_TOKEN";
  const directory = (await ctx.env("CLAUDE_CONFIG_DIR")) ?? "~/.claude";
  if (await ctx.fileExists(`${directory}/.credentials.json`)) return "Claude Code login";
  // macOS keeps the login in the Keychain; a Claude Code profile is the visible sign of one.
  if (platform === "darwin" && await ctx.fileExists("~/.claude.json")) return "Claude Code login";
  return undefined;
}

/**
 * Claude subscription login for Pi.
 *
 * Pi stores no Claude credential for the browser route. A long-lived token is the exception:
 * it is Pi's provider-scoped env, the same place Pi keeps any other provider variable.
 * `isSubscription` is not part of Pi's api-key type. Pi does not read it; other tools do.
 */
export function createClaudeCodeLogin(dependencies: ClaudeLoginDependencies = {}): ApiKeyAuth & { isSubscription: true } {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const account = dependencies.account ?? (signal => accountFromClaude(signal, env));
  const run = dependencies.spawn ?? spawnClaudeLogin;

  return {
    name: "Claude Code login",
    isSubscription: true,
    check: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      const source = await loginSource(ctx, credential, platform);
      return source ? { type: "api_key", source } : undefined;
    },
    resolve: async ({ ctx, credential, signal }) => {
      signal.throwIfAborted();
      const source = await loginSource(ctx, credential, platform);
      if (!source) return undefined;
      // No key. Claude Code holds the secret. On Pi 0.99.2 and 1.2.0 a custom stream is
      // still invoked for `{ auth: {} }`, the model stays available, and `print-api-key`
      // has nothing to print. A placeholder key would be printed.
      return credential?.env ? { auth: {}, source, env: credential.env } : { auth: {}, source };
    },
    login: interaction => signIn(interaction, { env, account, run, executable: dependencies.executable ?? claudeCodeExecutable }),
  };
}

export const claudeCodeLogin: ApiKeyAuth & { isSubscription: true } = createClaudeCodeLogin();

interface Who { email?: string; plan: string }

/** A claude.ai subscription the SDK named. An API key or a cloud provider is not one. */
function signedInAs(account: AccountInfo | undefined): Who | undefined {
  if (!account) return undefined;
  if (account.apiProvider && account.apiProvider !== "firstParty") return undefined;
  if (account.apiKeySource && account.apiKeySource !== "none") return undefined;
  const plan = account.subscriptionType?.trim();
  if (!plan) return undefined;
  const email = account.email?.trim();
  return { email: email || undefined, plan };
}

function whoLabel(who: Who): string {
  return who.email ? `${who.email} (${who.plan})` : who.plan;
}

/**
 * Pi treats a rejection whose message is exactly "Login cancelled" as the user backing out.
 * A bare `abort()` carries a DOMException instead, which the dialog would show as a failure.
 */
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name !== "AbortError") return signal.reason;
  return new Error("Login cancelled");
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

async function signIn(
  interaction: ProviderAuthInteraction,
  hooks: {
    env: NodeJS.ProcessEnv;
    account: (signal: AbortSignal) => Promise<AccountInfo | undefined>;
    run: NonNullable<ClaudeLoginDependencies["spawn"]>;
    executable: () => string;
  },
): Promise<ApiKeyCredential> {
  const signal = interaction.signal;
  throwIfCancelled(signal);
  const current = await namedAccount(hooks.account, signal);
  if (current) {
    const choice = await interaction.prompt({
      type: "select",
      message: `Signed in as ${whoLabel(current)}.`,
      options: [
        { id: "keep", label: "Keep this login" },
        { id: "again", label: "Sign in again" },
      ],
    });
    throwIfCancelled(signal);
    if (choice === "keep") return { type: "api_key" };
    if (choice !== "again") throw new Error(`Unknown login choice: ${choice}`);
  }

  const route = await interaction.prompt({
    type: "select",
    message: "Sign in to Claude",
    options: [
      { id: "claude-code", label: "Sign in with Claude Code", description: "Opens a browser for your Claude subscription" },
      { id: "token", label: "Paste a long-lived token", description: "From claude setup-token, for a machine without a browser" },
    ],
  });
  throwIfCancelled(signal);
  if (route === "token") return pasteToken(interaction);
  if (route !== "claude-code") throw new Error(`Unknown login choice: ${route}`);

  // `--claudeai` is the subscription. `--console` would bill the Anthropic API instead.
  const child = hooks.run(hooks.executable(), ["auth", "login", "--claudeai"], childEnv(hooks.env), signal);
  try {
    await relayLogin(interaction, child);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.kill();
  throwIfCancelled(signal);
  const signedIn = signedInAs(await hooks.account(signal));
  if (!signedIn) throw new Error("Claude Code finished signing in, but it does not report a subscription.");
  interaction.notify({ type: "info", message: `Signed in as ${whoLabel(signedIn)}.` });
  return { type: "api_key" };
}

/** A lookup failure before login must not block the two routes. Abort still does. */
async function namedAccount(
  account: (signal: AbortSignal) => Promise<AccountInfo | undefined>,
  signal: AbortSignal,
): Promise<Who | undefined> {
  try {
    return signedInAs(await account(signal));
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    return undefined;
  }
}

async function pasteToken(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential> {
  const token = (await interaction.prompt({
    type: "secret",
    message: "Paste the token from claude setup-token",
  })).trim();
  throwIfCancelled(interaction.signal);
  if (!token) throw new Error("A token is required.");
  return { type: "api_key", env: { CLAUDE_CODE_OAUTH_TOKEN: token } };
}

/**
 * The login binary is not a terminal. It prints the URL, then `Paste code here if prompted >`
 * with no newline, and waits. A browser that reaches its localhost callback can finish first;
 * that cancels the paste prompt instead of failing the login.
 */
async function relayLogin(interaction: ProviderAuthInteraction, child: ClaudeLoginProcess): Promise<void> {
  const signal = interaction.signal;
  throwIfCancelled(signal);
  const onAbort = (): void => child.kill();
  signal.addEventListener("abort", onAbort);
  const promptSignal = new AbortController();
  const stopPrompt = (): void => promptSignal.abort();
  signal.addEventListener("abort", stopPrompt);

  let codeFailure: unknown;
  let codeTask: Promise<void> = Promise.resolve();
  const outputTask = readLoginOutput(interaction, child, promptSignal, task => {
    codeTask = task.then(() => undefined, (error: unknown) => {
      // The process exiting, or the dialog closing, aborts the paste prompt on purpose.
      if (signal.aborted || promptSignal.signal.aborted) return;
      codeFailure = error;
      child.kill();
    });
  });
  // Exiting cancels a paste prompt that lost the race to the browser callback.
  // The output is drained first: the prompt is started from that output, and judging
  // the exit before the buffer is read would drop the URL or the code the user pasted.
  const exitTask = child.exited.then(result => {
    stopPrompt();
    return result;
  });

  try {
    await outputTask;
    await codeTask;
    const result = await exitTask;
    if (signal.aborted) throw abortError(signal);
    if (codeFailure) throw codeFailure;
    if (result.signal !== null || result.code !== 0) throw exitError(result, child.stderr());
  } finally {
    stopPrompt();
    signal.removeEventListener("abort", onAbort);
    signal.removeEventListener("abort", stopPrompt);
  }
}

function readLoginOutput(
  interaction: ProviderAuthInteraction,
  child: ClaudeLoginProcess,
  promptSignal: AbortController,
  onCode: (task: Promise<void>) => void,
): Promise<void> {
  return (async () => {
    let pending = "";
    let announced = false;
    let opened = false;
    let pasting = false;
    const scan = (complete: boolean): void => {
      if (interaction.signal.aborted) return;
      if (!opened && pending.includes("Opening browser")) {
        opened = true;
        interaction.notify({ type: "progress", message: "Opening a browser to sign in with Claude." });
      }
      if (!announced) {
        const url = firstUrl(pending, complete);
        if (url) {
          announced = true;
          interaction.notify({
            type: "auth_url",
            url,
            instructions: "If the browser did not open, use this page and paste the code it shows.",
          });
        }
      }
      if (!pasting && pending.includes("Paste code here if prompted")) {
        pasting = true;
        onCode(acceptCode(interaction, child, promptSignal));
      }
    };
    for await (const chunk of child.output) {
      if (interaction.signal.aborted) return;
      pending = visible(pending + chunk).slice(-64_000);
      scan(false);
    }
    scan(true);
  })();
}

async function acceptCode(
  interaction: ProviderAuthInteraction,
  child: ClaudeLoginProcess,
  promptSignal: AbortController,
): Promise<void> {
  if (interaction.signal.aborted || promptSignal.signal.aborted) return;
  const entered = await interaction.prompt({
    type: "manual_code",
    message: "Paste code here if prompted",
    signal: promptSignal.signal,
  }).then(code => code, (error: unknown) => {
    if (interaction.signal.aborted || promptSignal.signal.aborted) return undefined;
    throw error;
  });
  if (entered === undefined || interaction.signal.aborted || promptSignal.signal.aborted) return;
  const code = entered.trim();
  if (!code) throw new Error("A code is required.");
  child.write(`${code}\n`);
}

function exitError(result: { code: number | null; signal: NodeJS.Signals | null }, stderr: string): Error {
  const why = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? "unknown"}`;
  const detail = stderr.trim().slice(0, 500);
  return new Error(detail ? `Claude Code login failed (${why}): ${detail}` : `Claude Code login failed (${why}).`);
}

/** Drop ANSI colour. A terminal hyperlink is its target, not the target plus the visible copy. */
function visible(text: string): string {
  return text
    .replace(/\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)(.*?)\u001b\]8;;(?:\u0007|\u001b\\)/gs, "$1")
    .replace(/\u001b\]8;;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g, "$1")
    .replace(/\u001b\[[0-9;]*m/g, "");
}

function firstUrl(text: string, complete: boolean): string | undefined {
  const visit = /visit:\s*(https:\/\/\S+)/.exec(text);
  const match = visit ?? /https:\/\/\S+/.exec(text);
  if (!match) return undefined;
  const url = match[1] ?? match[0];
  const end = match.index + match[0].length;
  // A URL that runs off the end of the buffer may still be arriving in the next chunk.
  if (!complete && end >= text.length) return undefined;
  return url.replace(/[.,)>\]]+$/, "");
}

function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(subscriptionEnv(source, packageVersion()))) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

let version: string | undefined;

function packageVersion(): string {
  version ??= readPackageVersion();
  return version;
}

function readPackageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string"
    ? manifest.version : "0.0.0";
}

/**
 * The binary the Agent SDK actually spawns: its optional platform package, resolved
 * from the SDK itself, not `claude` on `PATH`.
 */
export function claudeCodeExecutable(): string {
  const require = createRequire(import.meta.resolve(SDK_PACKAGE));
  const arch = process.arch;
  const platform = process.platform;
  const extension = platform === "win32" ? ".exe" : "";
  const packages = platform === "android"
    ? [`${SDK_PACKAGE}-linux-${arch}-android`]
    : platform === "linux"
      ? preferMusl()
        ? [`${SDK_PACKAGE}-linux-${arch}-musl`, `${SDK_PACKAGE}-linux-${arch}`]
        : [`${SDK_PACKAGE}-linux-${arch}`, `${SDK_PACKAGE}-linux-${arch}-musl`]
      : [`${SDK_PACKAGE}-${platform}-${arch}`];
  for (const name of packages) {
    try {
      const path = require.resolve(`${name}/claude${extension}`);
      if (existsSync(path)) return path;
    } catch {
      // This optional package is not installed for the current libc or platform.
    }
  }
  throw new Error(`Claude Code binary for ${platform}-${arch} was not found. Reinstall ${SDK_PACKAGE} without --omit=optional.`);
}

function preferMusl(): boolean {
  if (process.platform !== "linux") return false;
  const getReport = process.report?.getReport;
  if (typeof getReport !== "function") return false;
  const report = getReport.call(process.report) as { header?: { glibcVersionRuntime?: string } } | null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

function spawnClaudeLogin(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  _signal: AbortSignal,
): ClaudeLoginProcess {
  const child = spawn(executable, [...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so cancelling also stops the browser opener it spawns.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stderr = "";
  const output = stdoutOf(child);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  child.stdin.on("error", () => {});
  let settled = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal: exitSignal });
    };
    child.once("error", error => {
      stderr = stderr || error.message;
      finish(1, null);
    });
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
  });
  return {
    output,
    stderr: () => stderr,
    write(text) { child.stdin.write(text); },
    kill() {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      const pid = child.pid;
      if (pid !== undefined && process.platform !== "win32") {
        try { process.kill(-pid, "SIGTERM"); }
        catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (pid !== undefined && process.platform !== "win32") {
          try { process.kill(-pid, "SIGKILL"); }
          catch { /* already gone */ }
        } else child.kill("SIGKILL");
      }, 1_000);
      timer.unref();
    },
    exited,
  };
}

/** stdout chunks, ended when the process closes or fails to start. */
function stdoutOf(child: ChildProcessWithoutNullStreams): AsyncIterable<string> {
  const chunks: string[] = [];
  const waiting: Array<(result: IteratorResult<string>) => void> = [];
  let ended = false;
  const push = (text: string): void => {
    if (!text) return;
    const waiter = waiting.shift();
    if (waiter) waiter({ value: text, done: false });
    else chunks.push(text);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    for (const waiter of waiting.splice(0)) waiter({ value: undefined, done: true });
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", push);
  child.once("close", end);
  child.once("error", end);
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const queued = chunks.shift();
        if (queued !== undefined) {
          yield queued;
          continue;
        }
        if (ended) return;
        const next = await new Promise<IteratorResult<string>>(resolve => waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

async function accountFromClaude(signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<AccountInfo | undefined> {
  throwIfCancelled(signal);
  const visibleLogin = await loginSource({
    env: async name => env[name],
    fileExists: path => fileExists(path),
  });
  if (!visibleLogin) return undefined;
  return queryAccount(signal, env);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(expandHome(path));
    return true;
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** The SDK's handshake names the account and does not send a prompt. */
async function queryAccount(signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<AccountInfo> {
  throwIfCancelled(signal);
  const start = await loadQuery();
  throwIfCancelled(signal);
  const inbox = new Inbox();
  const query = start({
    prompt: inbox,
    options: {
      cwd: process.cwd(),
      env: subscriptionEnv(env, packageVersion()),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      stderr: () => {},
    },
  });
  let stop: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    stop = () => {
      query.close();
      reject(abortError(signal));
    };
  });
  stopped.catch(() => {});
  if (signal.aborted) stop!();
  else signal.addEventListener("abort", stop!, { once: true });
  try {
    return (await Promise.race([stopped, query.initializationResult()])).account;
  } finally {
    signal.removeEventListener("abort", stop!);
    inbox.end();
    query.close();
  }
}

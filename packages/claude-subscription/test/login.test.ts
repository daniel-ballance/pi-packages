import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ApiKeyCredential, AuthContext, AuthEvent, AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
  claudeCodeExecutable,
  createClaudeCodeLogin,
  type ClaudeLoginProcess,
} from "../extensions/claude-subscription/src/login.js";

const signal = (): AbortSignal => new AbortController().signal;

function ctx(env: Record<string, string | undefined> = {}, files: string[] = []): AuthContext {
  return {
    env: async name => env[name],
    fileExists: async path => files.includes(path),
  };
}

const max: AccountInfo = {
  email: "user@example.com",
  subscriptionType: "Claude Max",
  apiProvider: "firstParty",
  apiKeySource: "none",
};

const VISIT = "https://claude.example/oauth/code?code_challenge=fake&state=fake";

/** The shape `claude auth login` prints when it is not a terminal: URL, then a paste prompt with no newline. */
const loginOutput = [
  "Opening browser to sign in…\n",
  `If the browser didn't open, visit: ${VISIT}\n`,
  "Paste code here if prompted > ",
];

/**
 * A Claude Code login process whose stdout is scripted.
 * `write` closes it once the code has been pasted. `close` finishes as soon as the
 * output has been read, the way a browser callback finishes without a pasted code.
 * `kill` ends it and its output; a second kill after it has exited does nothing.
 */
class FakeLogin implements ClaudeLoginProcess {
  readonly written: string[] = [];
  killed = 0;
  private settled = false;
  private resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private resolveDrain!: () => void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly drained: Promise<void>;

  constructor(
    private readonly chunks: readonly string[],
    private readonly mode: "write" | "close",
    private readonly exitCode = 0,
    private readonly stderrText = "",
  ) {
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    this.drained = new Promise(resolve => { this.resolveDrain = resolve; });
  }

  private finish(result: { code: number | null; signal: NodeJS.Signals | null }): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveExit(result);
    this.resolveDrain();
  }

  write(text: string): void {
    this.written.push(text);
    if (this.mode === "write") this.finish({ code: this.exitCode, signal: null });
  }

  kill(): void {
    if (this.settled) return;
    this.killed += 1;
    this.finish({ code: null, signal: "SIGTERM" });
  }

  stderr(): string {
    return this.stderrText;
  }

  readonly output: AsyncIterable<string> = { [Symbol.asyncIterator]: () => this.iterate() };

  private async *iterate(): AsyncGenerator<string> {
    for (const chunk of this.chunks) {
      if (this.settled) return;
      yield chunk;
    }
    if (this.settled) return;
    if (this.mode === "close") this.finish({ code: this.exitCode, signal: null });
    await this.drained;
  }
}

type Answer = string | "cancel" | "abort";

/** A `ProviderAuthInteraction` with preset answers. A prompt with no answer waits, and aborts when its signal does. */
class Dialog {
  readonly prompts: AuthPrompt[] = [];
  readonly events: AuthEvent[] = [];
  readonly controller = new AbortController();
  private readonly waiting: Array<(value: string) => void> = [];

  constructor(private readonly answers: Answer[]) {}

  readonly interaction: ProviderAuthInteraction = {
    signal: this.controller.signal,
    notify: event => { this.events.push(event); },
    prompt: prompt => this.ask(prompt),
  };

  private ask(prompt: AuthPrompt): Promise<string> {
    this.prompts.push(prompt);
    const answer = this.answers.shift();
    if (answer === "abort") {
      this.controller.abort();
      throw new Error("Login cancelled");
    }
    if (answer === "cancel") throw new Error("Login cancelled");
    if (typeof answer === "string") return Promise.resolve(answer);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(new Error("Login cancelled"));
      if (prompt.signal?.aborted || this.controller.signal.aborted) {
        onAbort();
        return;
      }
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(value => {
        prompt.signal?.removeEventListener("abort", onAbort);
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      });
    });
  }
}

interface SpawnCall { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }

/** `login` is optional on the type. A missing one is a failed test, not a rejection to assert. */
async function rejected(promise: Promise<unknown> | undefined, pattern: RegExp): Promise<void> {
  assert.ok(promise);
  await assert.rejects(promise, pattern);
}

function harness(options: {
  accounts: Array<AccountInfo | undefined>;
  child?: FakeLogin;
  env?: NodeJS.ProcessEnv;
  executable?: () => string;
}) {
  const calls: SpawnCall[] = [];
  const queue = [...options.accounts];
  const auth = createClaudeCodeLogin({
    env: options.env ?? {},
    executable: options.executable ?? (() => "/fake/claude"),
    spawn: (executable, args, env) => {
      calls.push({ executable, args, env });
      if (!options.child) throw new Error("login spawned Claude Code with no scripted process");
      return options.child;
    },
    account: async () => queue.shift(),
  });
  return { auth, calls };
}

test("check and resolve see a Claude login and never invent a key", async () => {
  const auth = createClaudeCodeLogin({ platform: "linux" });
  const none = ctx({}, ["~/.claude.json"]);
  assert.equal(await auth.check?.({ ctx: none, signal: signal() }), undefined);
  assert.equal(await auth.resolve({ ctx: none, signal: signal() }), undefined);
  // A placeholder left in Pi's auth.json is not a Claude credential.
  assert.equal(await auth.resolve({
    ctx: none, signal: signal(), credential: { type: "api_key", key: "claude-code-login" },
  }), undefined);

  const file = ctx({}, ["~/.claude/.credentials.json"]);
  assert.deepEqual(await auth.check?.({ ctx: file, signal: signal() }), { type: "api_key", source: "Claude Code login" });
  assert.deepEqual(await auth.resolve({ ctx: file, signal: signal() }), { auth: {}, source: "Claude Code login" });
  assert.equal((await auth.resolve({
    ctx: ctx({ CLAUDE_CONFIG_DIR: "/cfg" }, ["/cfg/.credentials.json"]), signal: signal(),
  }))?.source, "Claude Code login");
  assert.deepEqual(await auth.resolve({
    ctx: ctx({ CLAUDE_CODE_OAUTH_TOKEN: "ambient" }, []), signal: signal(),
  }), { auth: {}, source: "CLAUDE_CODE_OAUTH_TOKEN" });
  assert.equal(await auth.check?.({ ctx: ctx({ CLAUDE_CODE_OAUTH_TOKEN: "" }), signal: signal() }), undefined);

  const mac = createClaudeCodeLogin({ platform: "darwin" });
  assert.deepEqual(await mac.check?.({ ctx: ctx({}, ["~/.claude.json"]), signal: signal() }), {
    type: "api_key", source: "Claude Code login",
  });
});

test("a stored provider env counts as the login and is handed back for the request", async () => {
  const auth = createClaudeCodeLogin({ platform: "linux" });
  const credential: ApiKeyCredential = {
    type: "api_key",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "long-lived", HTTPS_PROXY: "http://proxy.example" },
  };
  const input = { ctx: ctx(), credential, signal: signal() };
  assert.deepEqual(await auth.check?.(input), { type: "api_key", source: "CLAUDE_CODE_OAUTH_TOKEN" });
  const resolved = await auth.resolve(input);
  assert.deepEqual(resolved, {
    auth: {},
    source: "CLAUDE_CODE_OAUTH_TOKEN",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "long-lived", HTTPS_PROXY: "http://proxy.example" },
  });

  // The token wins over a credentials file, and the whole stored map is what the request receives.
  const both = await auth.resolve({
    ctx: ctx({}, ["~/.claude/.credentials.json"]),
    credential: { type: "api_key", env: { CLAUDE_CODE_OAUTH_TOKEN: "long-lived", EXTRA: "1" } },
    signal: signal(),
  });
  assert.equal(both?.source, "CLAUDE_CODE_OAUTH_TOKEN");
  assert.deepEqual(both?.env, { CLAUDE_CODE_OAUTH_TOKEN: "long-lived", EXTRA: "1" });
});

test("signing in with Claude Code relays the URL and the pasted code, and stores nothing", async () => {
  const child = new FakeLogin(loginOutput, "write");
  const { auth, calls } = harness({
    accounts: [undefined, max],
    child,
    env: {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-not-for-claude",
      CLAUDE_CODE_ENTRYPOINT: "parent-session",
      CLAUDE_CODE_OAUTH_TOKEN: "already-set",
    },
  });
  const dialog = new Dialog(["claude-code", "pasted-code"]);
  const credential = await auth.login?.(dialog.interaction);
  assert.deepEqual(credential, { type: "api_key" });
  assert.deepEqual(child.written, ["pasted-code\n"]);
  assert.equal(child.killed, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["auth", "login", "--claudeai"]);
  assert.equal(calls[0].executable, "/fake/claude");
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(calls[0].env.CLAUDE_CODE_OAUTH_TOKEN, "already-set");
  assert.match(calls[0].env.CLAUDE_AGENT_SDK_CLIENT_APP ?? "", /^pi-claude-subscription\//);
  assert.deepEqual(dialog.events.map(event => event.type), ["progress", "auth_url", "info"]);
  assert.deepEqual(dialog.events[1], {
    type: "auth_url",
    url: VISIT,
    instructions: "If the browser did not open, use this page and paste the code it shows.",
  });
  assert.deepEqual(dialog.events[2], { type: "info", message: "Signed in as user@example.com (Claude Max)." });
  assert.equal(dialog.prompts[1]?.type, "manual_code");
});

test("a URL split across chunks is relayed whole, including one wrapped in terminal escapes", async () => {
  const [head, tail] = [VISIT.slice(0, 24), VISIT.slice(24)];
  const child = new FakeLogin([
    `Opening browser to sign in…\nIf the browser didn't open, visit: ${head}`,
    `${tail}\nPaste code here if prompted > `,
  ], "write");
  const { auth } = harness({ accounts: [undefined, max], child });
  const dialog = new Dialog(["claude-code", "split-code"]);
  await auth.login?.(dialog.interaction);
  assert.equal(dialog.events.find(event => event.type === "auth_url" && event.url === VISIT)?.type, "auth_url");
  assert.deepEqual(child.written, ["split-code\n"]);

  const linked = new FakeLogin([
    "\u001b[32mOpening browser to sign in…\u001b[0m\n",
    `visit: \u001b]8;;${VISIT}\u0007${VISIT}\u001b]8;;\u0007\n`,
    "Paste code here if pro",
    "mpted > ",
  ], "write");
  const second = harness({ accounts: [undefined, { subscriptionType: "Pro", apiProvider: "firstParty" }], child: linked });
  const again = new Dialog(["claude-code", "colour-code"]);
  const credential = await second.auth.login?.(again.interaction);
  assert.deepEqual(credential, { type: "api_key" });
  assert.equal(again.events.find(event => event.type === "auth_url") && (again.events.find(event => event.type === "auth_url") as { url: string }).url, VISIT);
  assert.deepEqual(again.events.at(-1), { type: "info", message: "Signed in as Pro." });
  assert.deepEqual(linked.written, ["colour-code\n"]);
});

test("a browser callback that finishes the login cancels the paste prompt", async () => {
  const child = new FakeLogin(loginOutput, "close");
  const { auth, calls } = harness({ accounts: [undefined, max], child });
  const dialog = new Dialog(["claude-code"]);
  const credential = await auth.login?.(dialog.interaction);
  assert.deepEqual(credential, { type: "api_key" });
  assert.deepEqual(child.written, []);
  assert.equal(child.killed, 0);
  assert.equal(calls.length, 1);
  assert.equal(dialog.prompts.at(-1)?.type, "manual_code");
  assert.equal(dialog.prompts.at(-1)?.signal?.aborted, true);
});

test("pasting a long-lived token stores it as the provider env and does not spawn Claude", async () => {
  const { auth, calls } = harness({ accounts: [undefined] });
  const dialog = new Dialog(["token", "  setup-token-value  "]);
  assert.deepEqual(await auth.login?.(dialog.interaction), {
    type: "api_key",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token-value" },
  });
  assert.equal(calls.length, 0);
  assert.equal(dialog.prompts[1]?.type, "secret");

  const blank = new Dialog(["token", "   "]);
  await rejected(harness({ accounts: [undefined] }).auth.login?.(blank.interaction), /A token is required/);
});

test("someone already signed in can keep that login or replace it", async () => {
  const keep = harness({ accounts: [max] });
  const keeping = new Dialog(["keep"]);
  assert.deepEqual(await keep.auth.login?.(keeping.interaction), { type: "api_key" });
  assert.equal(keep.calls.length, 0);
  assert.equal(keeping.prompts.length, 1);
  assert.equal(keeping.prompts[0]?.type, "select");
  assert.equal(keeping.prompts[0] && keeping.prompts[0].type === "select" ? keeping.prompts[0].message : "", "Signed in as user@example.com (Claude Max).");
  assert.deepEqual(keeping.events, []);

  const child = new FakeLogin(loginOutput, "write");
  const again = harness({ accounts: [max, max], child });
  const dialog = new Dialog(["again", "claude-code", "new-code"]);
  assert.deepEqual(await again.auth.login?.(dialog.interaction), { type: "api_key" });
  assert.equal(again.calls.length, 1);
  assert.deepEqual(child.written, ["new-code\n"]);

  const token = harness({ accounts: [{ subscriptionType: "Claude Max" }] });
  assert.deepEqual(await token.auth.login?.(new Dialog(["again", "token", "replaced"]).interaction), {
    type: "api_key", env: { CLAUDE_CODE_OAUTH_TOKEN: "replaced" },
  });
});

test("an account that is not a claude.ai subscription is not offered as the current login", async () => {
  const { auth, calls } = harness({
    accounts: [{ subscriptionType: "Claude Max", apiProvider: "bedrock", email: "user@example.com" }],
  });
  const dialog = new Dialog(["token", "from-setup-token"]);
  await auth.login?.(dialog.interaction);
  assert.equal(dialog.prompts[0]?.type, "select");
  assert.equal(dialog.prompts[0] && dialog.prompts[0].type === "select" ? dialog.prompts[0].message : "", "Sign in to Claude");
  assert.equal(calls.length, 0);
});

test("a login that ends without a subscription stores nothing", async () => {
  const finished = new FakeLogin([], "close");
  const { auth } = harness({
    accounts: [undefined, { apiProvider: "firstParty", apiKeySource: "none", email: "user@example.com" }],
    child: finished,
  });
  await rejected(
    auth.login?.(new Dialog(["claude-code"]).interaction),
    /Claude Code finished signing in, but it does not report a subscription/,
  );

  const billed = new FakeLogin(loginOutput, "close");
  const apiKey = harness({
    accounts: [undefined, { ...max, apiKeySource: "ANTHROPIC_API_KEY" }],
    child: billed,
  });
  await rejected(
    apiKey.auth.login?.(new Dialog(["claude-code"]).interaction),
    /does not report a subscription/,
  );
  assert.equal(billed.killed, 0);
});

test("a login that fails, or a paste the user rejects, kills the child and stores nothing", async () => {
  const failed = new FakeLogin(["Opening browser to sign in…\n"], "close", 2, "disk full\n");
  const { auth } = harness({ accounts: [undefined], child: failed });
  await rejected(auth.login?.(new Dialog(["claude-code"]).interaction), /Claude Code login failed \(exit 2\): disk full/);

  const child = new FakeLogin(loginOutput, "write");
  const running = harness({ accounts: [undefined, max], child });
  await rejected(running.auth.login?.(new Dialog(["claude-code", "cancel"]).interaction), /Login cancelled/);
  assert.equal(child.killed, 1);
  assert.deepEqual(child.written, []);

  const empty = new FakeLogin(loginOutput, "write");
  await rejected(
    harness({ accounts: [undefined], child: empty }).auth.login?.(new Dialog(["claude-code", "   "]).interaction),
    /A code is required/,
  );
  assert.equal(empty.killed, 1);
});

test("cancelling the dialog kills the Claude Code login", async () => {
  const child = new FakeLogin(loginOutput, "write");
  const { auth, calls } = harness({ accounts: [undefined], child });
  await rejected(auth.login?.(new Dialog(["claude-code", "abort"]).interaction), /Login cancelled/);
  assert.equal(child.killed, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(child.written, []);

  const { auth: signedOut, calls: none } = harness({ accounts: [undefined] });
  await rejected(signedOut.login?.(new Dialog(["abort"]).interaction), /Login cancelled/);
  assert.equal(none.length, 0);
});

test("a handshake failure before the menu still offers both routes", async () => {
  let calls = 0;
  const auth = createClaudeCodeLogin({
    account: async () => {
      calls += 1;
      if (calls === 1) throw new Error("handshake failed");
      return max;
    },
    executable: () => "/fake/claude",
    spawn: () => { throw new Error("should have pasted a token"); },
  });
  const credential = await auth.login?.(new Dialog(["token", "after-failure"]).interaction);
  assert.deepEqual(credential, { type: "api_key", env: { CLAUDE_CODE_OAUTH_TOKEN: "after-failure" } });
  assert.equal(calls, 1);
});

test("an unknown choice is rejected", async () => {
  const { auth } = harness({ accounts: [undefined] });
  await rejected(auth.login?.(new Dialog(["somewhere-else"]).interaction), /Unknown login choice: somewhere-else/);
  const signedIn = harness({ accounts: [max] });
  await rejected(signedIn.auth.login?.(new Dialog(["forget"]).interaction), /Unknown login choice: forget/);
});

test("the login runs the Claude Code binary shipped inside the Agent SDK", () => {
  const path = claudeCodeExecutable();
  assert.equal(existsSync(path), true);
  assert.match(path, new RegExp(`claude-agent-sdk-${process.platform}-${process.arch}[^/]*/claude$`));
});

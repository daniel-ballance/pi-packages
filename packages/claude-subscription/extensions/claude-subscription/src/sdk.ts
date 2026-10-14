import type {
  EffortLevel,
  Options,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The part of an Agent SDK query this package drives. */
export interface AgentQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<SDKControlInitializeResponse>;
  interrupt(): Promise<unknown>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  setModel(model?: string): Promise<void>;
  getContextUsage(options?: { detail?: "summary" | "full" }): Promise<SDKControlGetContextUsageResponse>;
  /** The data behind Claude Code's `/usage`. Anthropic marks it unstable, so it may be missing. */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options?: { skipBehaviors?: boolean }): Promise<unknown>;
  close(): void;
}

/** The Agent SDK's `query()`, narrowed to streaming input. Tests substitute a scripted one. */
export type QueryFunction = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentQuery;

let loaded: Promise<QueryFunction> | undefined;

/** Load the SDK on first use, so starting Pi does not pay for a provider that may go unused. */
export function loadQuery(): Promise<QueryFunction> {
  loaded ??= import("@anthropic-ai/claude-agent-sdk").then(sdk => sdk.query);
  return loaded;
}

/**
 * Variables that would move Claude Code off the claude.ai login and onto an API key,
 * a gateway or a cloud provider, all of which bill per token.
 */
const API_ROUTING = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Variables a running Claude Code session sets for its own children. When Pi is started
 * from inside one, they describe that session, not the process this package starts.
 */
const PARENT_SESSION = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
];

/**
 * Environment for the Claude Code process: the caller's, then the provider-scoped values Pi
 * resolved for the request, minus per-token API routing and another session's identity.
 */
export function subscriptionEnv(
  source: NodeJS.ProcessEnv, version: string, scoped: Record<string, string> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source, ...scoped };
  for (const name of [...API_ROUTING, ...PARENT_SESSION]) delete env[name];
  env.CLAUDE_AGENT_SDK_CLIENT_APP = `pi-claude-subscription/${version}`;
  return env;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** User turns for a running query: pushed whenever Pi has input, read by the SDK as they arrive. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private wake: Deferred<void> | undefined;
  private ended = false;

  push(message: SDKUserMessage): void {
    this.queue.push(message);
    this.wake?.resolve();
  }

  end(): void {
    this.ended = true;
    this.wake?.resolve();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
    for (;;) {
      const next = this.queue.shift();
      if (next) yield next;
      else if (this.ended) return;
      else {
        this.wake = deferred<void>();
        await this.wake.promise;
      }
    }
  }
}

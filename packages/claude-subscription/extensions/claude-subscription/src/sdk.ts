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

/** Environment for the Claude Code process: the caller's, minus per-token API routing. */
export function subscriptionEnv(source: NodeJS.ProcessEnv, version: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  for (const name of API_ROUTING) delete env[name];
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

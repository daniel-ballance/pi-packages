import type { AccountInfo, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  isModelType,
  lazyStream,
  type Api,
  type AssistantMessageEventStream,
  type AuthContext,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID, PROVIDER_NAME, baselineModels, discoveredModels, rehome, thinkingFor, type SubscriptionModel } from "./models.js";
import { Inbox, loadQuery, subscriptionEnv, type AgentQuery, type QueryFunction } from "./sdk.js";
import { AgentSession, type SessionHost } from "./session.js";
import { readTranscript } from "./transcript.js";

export interface SubscriptionOptions {
  /** Package version, reported to Anthropic as the calling app. */
  version: string;
  /** Substitute for the Agent SDK's `query()`. */
  query?: QueryFunction;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  /** Called when the account or its plan limits become known or change. */
  onChange?(): void;
}

/** Open sessions beyond this are closed, least recently used first. */
const MAX_SESSIONS = 4;
/** A waiting conversation keeps its Claude Code process this long. */
const IDLE_MS = 30 * 60_000;
/** Requests without tools are one-off calls such as summaries; they rarely continue. */
const IDLE_WITHOUT_TOOLS_MS = 60_000;
/** The account's model list changes rarely; ask Claude Code again after this long. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Pi requires a key or headers on some request paths. Claude Code holds the real
 * credential and this provider never reads it; this placeholder only marks "configured".
 */
const LOGIN_MARKER = "claude-code-login";

async function loginSource(ctx: AuthContext): Promise<string | undefined> {
  if (await ctx.env("CLAUDE_CODE_OAUTH_TOKEN")) return "CLAUDE_CODE_OAUTH_TOKEN";
  const directory = (await ctx.env("CLAUDE_CONFIG_DIR")) ?? "~/.claude";
  if (await ctx.fileExists(`${directory}/.credentials.json`)) return "Claude Code login";
  // macOS keeps the login in the Keychain; a Claude Code profile is the visible sign of one.
  if (process.platform === "darwin" && await ctx.fileExists("~/.claude.json")) return "Claude Code login";
  return undefined;
}

/** The provider and the Claude Code sessions behind it. */
export class ClaudeSubscription {
  readonly provider: Provider<typeof API_ID>;
  account: AccountInfo | undefined;
  rateLimit: SDKRateLimitInfo | undefined;
  private readonly baseline = baselineModels();
  private models: readonly SubscriptionModel[] = this.baseline;
  private readonly sessions = new Set<AgentSession>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly options: SubscriptionOptions) {
    this.provider = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      auth: {
        apiKey: {
          name: "Claude Code login",
          check: async ({ ctx }) => {
            const source = await loginSource(ctx);
            return source ? { type: "api_key", source } : undefined;
          },
          resolve: async ({ ctx }) => {
            const source = await loginSource(ctx);
            return source ? { auth: { apiKey: LOGIN_MARKER }, source } : undefined;
          },
        },
      },
      getModels: () => this.models,
      refreshModels: context => this.refreshModels(context),
      // No option here is specific to this API; a typed stream runs at the model's default thinking.
      stream: (model, context, request) => this.stream(model, context, request, {}),
      streamSimple: (model, context, request) => this.stream(model, context, request, request ?? {}),
    };
  }

  get openSessions(): number {
    return this.sessions.size;
  }

  private get query(): Promise<QueryFunction> {
    return this.options.query ? Promise.resolve(this.options.query) : loadQuery();
  }

  private get env(): Record<string, string | undefined> {
    return subscriptionEnv(this.options.env ?? process.env, this.options.version);
  }

  private stream(
    model: Model<Api>, context: TranscriptContext, request: StreamOptions | undefined,
    simple: Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "toolChoice">,
  ): AssistantMessageEventStream {
    const transcript = readTranscript(context, simple.toolChoice !== "none");
    const thinking = thinkingFor(model, simple);
    this.sweep();
    for (const session of this.sessions) {
      const fresh = session.continues(model, transcript, thinking);
      if (fresh) return session.respond(model, fresh, false, thinking, request);
    }
    return lazyStream(model, async () => {
      const host: SessionHost = {
        query: await this.query,
        env: this.env,
        cwd: this.options.cwd?.() ?? process.cwd(),
        onAccount: account => {
          this.account = account;
          this.options.onChange?.();
        },
        onRateLimit: info => {
          this.rateLimit = info;
          this.options.onChange?.();
        },
      };
      const session = new AgentSession(host, model, transcript, thinking);
      this.sessions.add(session);
      this.sweep();
      this.sweeper ??= setInterval(() => this.sweep(), IDLE_WITHOUT_TOOLS_MS).unref();
      return session.respond(model, transcript.entries, true, thinking, request);
    });
  }

  /** Drop finished and idle sessions, then the least recently used ones over the limit. */
  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions) {
      const idle = now - session.lastUsed > (session.hasTools ? IDLE_MS : IDLE_WITHOUT_TOOLS_MS);
      if (session.closed || (idle && !session.busy)) this.drop(session);
    }
    const waiting = [...this.sessions].filter(session => !session.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.sessions.size > MAX_SESSIONS && waiting.length) this.drop(waiting.shift()!);
    if (!this.sessions.size) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private drop(session: AgentSession): void {
    session.close();
    this.sessions.delete(session);
  }

  closeSessions(): void {
    for (const session of [...this.sessions]) this.drop(session);
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Start Claude Code without sending a prompt; its handshake names the account and models. */
  private async handshake<T>(signal: AbortSignal | undefined, use: (query: AgentQuery) => Promise<T>): Promise<T> {
    const inbox = new Inbox();
    const query = (await this.query)({
      prompt: inbox,
      options: {
        cwd: this.options.cwd?.() ?? process.cwd(),
        env: this.env,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    const stop = (): void => query.close();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      return await use(query);
    } finally {
      signal?.removeEventListener("abort", stop);
      inbox.end();
      query.close();
    }
  }

  /** The signed-in account, asking Claude Code when no session has reported it yet. */
  async identify(signal?: AbortSignal): Promise<AccountInfo> {
    this.account ??= await this.handshake(signal, async query => (await query.initializationResult()).account);
    return this.account;
  }

  private async refreshModels(context: RefreshModelsContext): Promise<void> {
    if (context.stored) {
      const known = new Map(this.baseline.map(model => [model.id, model]));
      const restored: SubscriptionModel[] = [];
      for (const model of context.stored.models) {
        // Limits follow the installed Pi wherever it knows the model.
        if (model.provider === PROVIDER_ID && isModelType(model, "chat")) restored.push(known.get(model.id) ?? rehome(model));
      }
      if (restored.length && !(await context.publish({ update: () => { this.models = restored; } }))) return;
    }
    if (!context.allowNetwork || context.signal.aborted) return;
    const checkedAt = context.stored?.checkedAt;
    if (!context.force && checkedAt !== undefined && Date.now() - checkedAt < CATALOG_MAX_AGE_MS) return;
    const models = await this.handshake(context.signal, async query => {
      const { account, models: reported } = await query.initializationResult();
      this.account = account;
      const discovered = discoveredModels(reported, this.baseline);
      for (const model of discovered) {
        if (this.baseline.includes(model)) continue;
        // Pi does not know this model yet, so take its window from Claude Code.
        await query.setModel(model.id);
        model.contextWindow = (await query.getContextUsage({ detail: "summary" })).rawMaxTokens;
      }
      return discovered;
    });
    if (!models.length || context.signal.aborted) return;
    await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => { this.models = models; } });
  }
}

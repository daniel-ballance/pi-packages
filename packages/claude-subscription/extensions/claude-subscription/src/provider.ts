import { randomUUID } from "node:crypto";
import type { AccountInfo, ModelUsage, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createAssistantMessageEventStream,
  isModelType,
  lazyStream,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID, PROVIDER_NAME, baselineModels, discoveredModels, rehome, thinkingFor, type SubscriptionModel, type Thinking } from "./models.js";
import { Inbox, loadQuery, subscriptionEnv, type AgentQuery, type QueryFunction } from "./sdk.js";
import { claudeCodeLogin } from "./login.js";
import { lookupResume, type SessionReader, type SessionStore } from "./resume.js";
import { AgentSession, type SessionHost } from "./session.js";
import { readTranscript, type Entry, type Transcript } from "./transcript.js";

export interface SubscriptionOptions {
  /** Package version, reported to Anthropic as the calling app. */
  version: string;
  /** Substitute for the Agent SDK's `query()`. */
  query?: QueryFunction;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  /**
   * Keep conversations on disk in Claude Code and continue them after a restart: where the
   * records of what each kept session holds are filed, and how Claude Code's own copy is read.
   */
  resume?: { store: SessionStore; read(): Promise<SessionReader> };
  /** Names of every tool Pi has registered, including ones not active now. */
  knownTools?(): readonly string[];
}

/** Conversations beyond this are closed, least recently used first. */
const MAX_SESSIONS = 4;
/** A waiting conversation keeps its Claude Code process this long. */
const IDLE_MS = 30 * 60_000;
/** Requests without tools are mostly one-off calls such as summaries; they rarely continue. */
const IDLE_WITHOUT_TOOLS_MS = 5 * 60_000;
/** One-off sessions kept at once; they do not count against the conversations. */
const MAX_WITHOUT_TOOLS = 2;
/** How often idle sessions are looked for. */
const SWEEP_MS = 60_000;
/** The account's model list changes rarely; ask Claude Code again after this long. */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;

/** What this Pi process has sent through the provider, priced at Anthropic's list rates. */
export interface Spend {
  /** Claude Code's estimate of the API price of the same usage. Nothing is billed per token. */
  costUsd: number;
  turns: number;
  models: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }>;
}

/** The provider and the Claude Code sessions behind it. */
export class ClaudeSubscription {
  readonly provider: Provider<typeof API_ID>;
  account: AccountInfo | undefined;
  rateLimit: SDKRateLimitInfo | undefined;
  /** Fast mode as Claude Code last reported it, with the reason when it is unavailable. */
  fastMode: { state: string; reason?: string } | undefined;
  readonly spend: Spend = { costUsd: 0, turns: 0, models: {} };
  private readonly baseline = baselineModels();
  private models: readonly SubscriptionModel[] = this.baseline.map(model => ({ ...model }));
  private readonly sessions = new Set<AgentSession>();
  private sweeper: NodeJS.Timeout | undefined;
  /** Advanced when the sessions are closed, so a request still being set up does not start one after. */
  private epoch = 0;
  /** Ends the wait of each request whose session is still starting. */
  private readonly starting = new Set<() => void>();

  constructor(private readonly options: SubscriptionOptions) {
    this.provider = {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      auth: { apiKey: claudeCodeLogin },
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

  private env(scoped?: Record<string, string>): Record<string, string | undefined> {
    return subscriptionEnv(this.options.env ?? process.env, this.options.version, scoped);
  }

  private stream(
    model: Model<Api>, context: TranscriptContext, request: StreamOptions | undefined,
    simple: Pick<SimpleStreamOptions, "reasoning" | "thinkingBudgets" | "toolChoice">,
  ): AssistantMessageEventStream {
    const transcript = readTranscript(context, simple.toolChoice !== "none");
    const thinking = thinkingFor(model, simple);
    this.sweep();
    for (const session of this.sessions) {
      const fresh = session.continues(transcript, thinking);
      if (fresh) return session.respond(model, transcript, fresh, false, thinking, request);
    }
    const { epoch } = this;
    return lazyStream(model, async () => {
      const query = await this.query;
      // Nothing is started for a request that was given up, or whose Pi session has ended, while the SDK loaded.
      if (request?.signal?.aborted) return ended(model, "aborted", "Request was aborted");
      if (epoch !== this.epoch) return ended(model, "error", "The Pi session ended before this request started.");
      /** Claude Code reports totals for the whole process; this is what earlier turns already counted. */
      let counted: Record<string, ModelUsage> | undefined = {};
      const cwd = this.options.cwd?.() ?? process.cwd();
      const { resume } = this.options;
      let session: AgentSession | undefined;
      const host: SessionHost = {
        query,
        env: this.env(request?.env),
        cwd,
        onAccount: account => {
          this.account = account;
        },
        onRateLimit: info => {
          this.rateLimit = info;
        },
        onResult: result => {
          this.count(result, counted);
          counted = result.modelUsage ?? counted ?? {};
        },
        knownTools: this.options.knownTools,
        onSettled: () => {
          const record = session?.record;
          // The totals go with the record: a later process that resumes the session counts on from them.
          if (record) void resume?.store.save({ ...record, totals: counted });
          this.sweep();
        },
      };
      // One-off requests are not conversations anyone comes back to; only those with tools are kept.
      const kept = resume && transcript.tools.length > 0 ? resume : undefined;
      const given = (): AssistantMessageEventStream | undefined => request?.signal?.aborted ? ended(model, "aborted", "Request was aborted")
        : epoch !== this.epoch ? ended(model, "error", "The Pi session ended before this request started.") : undefined;
      const found = kept && await this.resumable(kept, transcript, thinking, cwd);
      // Looking for a kept session took a moment; the request or Pi's session may have ended in it.
      if (given()) return given()!;
      let fresh: readonly Entry[] = transcript.entries;
      if (found) {
        const resumed = new AgentSession(host, model, transcript, thinking, { sessionId: found.record.sessionId, absorbed: found.record.keys });
        // In the pool from the start, so closing Pi's session closes it; and an abort does not wait for it to start.
        this.sessions.add(resumed);
        const started = await this.untilStarted(resumed, request?.signal);
        if (given()) {
          this.drop(resumed);
          return given()!;
        }
        if (started) {
          session = resumed;
          fresh = found.fresh;
          counted = usageTotals(found.record.totals);
        } else {
          // Claude Code refuses a session it no longer has; the conversation then starts over from Pi's transcript.
          this.drop(resumed);
        }
      }
      const seed = session === undefined;
      session ??= new AgentSession(host, model, transcript, thinking, kept ? { sessionId: randomUUID() } : undefined);
      this.sessions.add(session);
      // The response is started first: a session that is answering is never the one swept away.
      const stream = session.respond(model, transcript, fresh, seed, thinking, request);
      this.sweep();
      this.sweeper ??= setInterval(() => this.sweep(), SWEEP_MS).unref();
      return stream;
    });
  }

  /** Whether the session started, waiting no longer than the request or Pi's session lasts. */
  private async untilStarted(session: AgentSession, signal: AbortSignal | undefined): Promise<boolean> {
    let stop: (() => void) | undefined;
    const stopped = new Promise<boolean>(settle => {
      stop = () => settle(false);
    });
    signal?.addEventListener("abort", stop!, { once: true });
    this.starting.add(stop!);
    try {
      return await Promise.race([stopped, session.started.then(() => true, () => false)]);
    } finally {
      signal?.removeEventListener("abort", stop!);
      this.starting.delete(stop!);
    }
  }

  /** A session Claude Code kept that holds exactly the start of this transcript, checked against its own copy. */
  private async resumable(
    resume: NonNullable<SubscriptionOptions["resume"]>, transcript: Transcript, thinking: Thinking, cwd: string,
  ): Promise<{ record: { sessionId: string; keys: string[]; totals?: unknown }; fresh: Entry[] } | undefined> {
    try {
      return await lookupResume(resume.store, transcript, thinking, cwd, await resume.read());
    } catch {
      return undefined;
    }
  }

  /** Totals already counted for Claude Code sessions run outside the pool, by session id. */
  private readonly runs = new Map<string, Record<string, ModelUsage>>();

  /**
   * Count a turn of a Claude Code process this provider did not start itself: a delegated
   * task or a web tool. A resumed session reports totals since it began, so they are
   * differenced by session.
   */
  countRun(result: SDKResultMessage): void {
    const before = this.runs.get(result.session_id) ?? {};
    this.count(result, before);
    this.runs.set(result.session_id, result.modelUsage ?? before);
  }

  /** Take a plan-limit notice from such a process. */
  noteRateLimit(info: SDKRateLimitInfo): void {
    this.rateLimit = info;
  }

  /**
   * Add one turn's usage to the totals, and take the model's real limits from Claude Code.
   * `counted` is what earlier turns of the same Claude Code session already added; without
   * it (a resumed session whose earlier totals are unknown) only the limits are taken.
   */
  private count(result: SDKResultMessage, counted: Record<string, ModelUsage> | undefined): void {
    this.spend.turns++;
    for (const [id, usage] of Object.entries(result.modelUsage ?? {})) {
      // Pi compacts and judges truncation by these numbers, so they must be the transport's own.
      const model = this.models.find(candidate => candidate.id === id);
      if (model && usage.contextWindow > 0) model.contextWindow = usage.contextWindow;
      if (model && usage.maxOutputTokens > 0) model.maxTokens = usage.maxOutputTokens;
      if (!counted) continue;
      const before = counted[id];
      const total = this.spend.models[id] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      const cost = usage.costUSD - (before?.costUSD ?? 0);
      total.input += usage.inputTokens - (before?.inputTokens ?? 0);
      total.output += usage.outputTokens - (before?.outputTokens ?? 0);
      total.cacheRead += usage.cacheReadInputTokens - (before?.cacheReadInputTokens ?? 0);
      total.cacheWrite += usage.cacheCreationInputTokens - (before?.cacheCreationInputTokens ?? 0);
      total.costUsd += cost;
      this.spend.costUsd += cost;
    }
    if (result.fast_mode_state) {
      const reason = "fast_mode_disabled_reason" in result && typeof result.fast_mode_disabled_reason === "string"
        ? result.fast_mode_disabled_reason : undefined;
      this.fastMode = { state: result.fast_mode_state, reason };
    }
  }

  /**
   * Drop finished and idle sessions, then the least recently used ones over the limit.
   * A session paused on Pi's tools is left alone however long the tools take; one that is
   * answering is never touched.
   */
  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions) {
      if (session.closed) this.sessions.delete(session);
      else if (session.busy || session.awaitingTools) continue;
      else if (now - session.lastUsed > (session.hasTools ? IDLE_MS : IDLE_WITHOUT_TOOLS_MS)) this.drop(session);
    }
    for (const [withTools, limit] of [[true, MAX_SESSIONS], [false, MAX_WITHOUT_TOOLS]] as const) {
      const kind = [...this.sessions].filter(session => session.hasTools === withTools);
      // Waiting conversations go before ones in the middle of a tool call.
      const spare = kind.filter(session => !session.busy)
        .sort((a, b) => Number(a.awaitingTools) - Number(b.awaitingTools) || a.lastUsed - b.lastUsed);
      for (let over = kind.length - limit; over > 0 && spare.length; over--) this.drop(spare.shift()!);
    }
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
    this.epoch++;
    for (const stop of [...this.starting]) stop();
    for (const session of [...this.sessions]) this.drop(session);
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** Start Claude Code without sending a prompt; its handshake names the account and models. */
  private async handshake<T>(signal: AbortSignal | undefined, use: (query: AgentQuery) => Promise<T>): Promise<T> {
    const start = await this.query;
    if (signal?.aborted) throw new Error("Request was aborted");
    const inbox = new Inbox();
    const query = start({
      prompt: inbox,
      options: {
        cwd: this.options.cwd?.() ?? process.cwd(),
        env: this.env(),
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        persistSession: false,
      },
    });
    let stop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => {
        query.close();
        reject(new Error("Request was aborted"));
      };
    });
    stopped.catch(() => {});
    signal?.addEventListener("abort", stop!, { once: true });
    try {
      return await Promise.race([stopped, use(query)]);
    } finally {
      signal?.removeEventListener("abort", stop!);
      inbox.end();
      query.close();
    }
  }

  /** The signed-in account, asking Claude Code when no session has reported it yet. */
  async identify(signal?: AbortSignal): Promise<AccountInfo> {
    this.account ??= await this.handshake(signal, async query => (await query.initializationResult()).account);
    return this.account;
  }

  /**
   * The data behind Claude Code's `/usage`: plan windows, extra usage, per-model limits.
   * Undefined when Claude Code cannot say; the call is unstable upstream and never fails a caller.
   */
  async planUsage(signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.handshake(signal, async query =>
        await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true }));
    } catch {
      return undefined;
    }
  }

  private async refreshModels(context: RefreshModelsContext): Promise<void> {
    if (context.stored) {
      const known = new Map(this.baseline.map(model => [model.id, model]));
      const restored: SubscriptionModel[] = [];
      for (const model of context.stored.models) {
        if (model.provider !== PROVIDER_ID || !isModelType(model, "chat")) continue;
        const match = known.get(model.id);
        // Capabilities follow the installed Pi wherever it knows the model; the limits stay
        // the ones Claude Code reported, which can be smaller than the API's.
        restored.push(match ? { ...match, contextWindow: model.contextWindow, maxTokens: model.maxTokens } : rehome(model));
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
        // Pi's catalog describes the API. Through Claude Code some models get a smaller window.
        await query.setModel(model.id);
        const window = (await query.getContextUsage({ detail: "summary" })).rawMaxTokens;
        if (window > 0) model.contextWindow = window;
      }
      return discovered;
    });
    if (!models.length || context.signal.aborted) return;
    await context.publish({ persist: { models, checkedAt: Date.now() }, update: () => { this.models = models; } });
  }
}

/** Usage totals read back from a record, or nothing if they are not what Claude Code reports. */
function usageTotals(value: unknown): Record<string, ModelUsage> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"] as const;
  const totals: Record<string, ModelUsage> = {};
  for (const [id, usage] of Object.entries(value)) {
    if (typeof usage !== "object" || usage === null) return undefined;
    if (!fields.every(field => field in usage && typeof usage[field as keyof typeof usage] === "number" && Number.isFinite(usage[field as keyof typeof usage]))) return undefined;
    totals[id] = usage as ModelUsage;
  }
  return totals;
}

/** A response that ended before any Claude Code process was involved. */
function ended(model: Model<Api>, reason: "aborted" | "error", errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error = {
    role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason, errorMessage, timestamp: Date.now(),
  };
  stream.push({ type: "error", reason, error });
  stream.end();
  return stream;
}

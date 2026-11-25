import { statSync } from "node:fs";
import { isModelType, type Api, type Model, type Provider, type RefreshModelsContext, type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID, baselineModels, catalog, type AntigravityModel } from "./models.js";
import { messageOf, withSignal } from "./errors.js";
import { AgyProcess, executable, type ProcessOptions } from "./process.js";
import { Response } from "./response.js";
import { AgentSession, type Loadout } from "./session.js";
import { appendPrompt, forwardedSections, projectRoot } from "./prompt.js";
import { STAND_IN, failure, listTools, type ToolInfo } from "./tools.js";
import { readTranscript } from "./transcript.js";

const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000;
interface PiBinding {
  cwd: string;
  tools: { getActiveTools(): string[]; getAllTools(): ToolInfo[] };
  wake(id: string): boolean;
}

export interface AntigravityOptions extends ProcessOptions {
  toolTimeoutMs?: number;
  maxSessions?: number;
  idleMs?: number;
  now?(): number;
  bindPi?(scope: string | undefined): PiBinding | undefined;
}

export class Antigravity {
  readonly provider: Provider<typeof API_ID>;
  private models = baselineModels();
  private readonly sessions = new Set<AgentSession>();
  private readonly probes = new Set<AgyProcess>();
  private readonly retiring = new Set<Promise<void>>();
  private sweeper?: NodeJS.Timeout;
  private epoch = 0;
  private readonly now: () => number;

  constructor(private readonly options: AntigravityOptions) {
    this.now = options.now ?? Date.now;
    const installed = () => executable(options.env ?? process.env, options.executable);
    const source = "Antigravity CLI (Google sign-in)";
    this.provider = {
      id: PROVIDER_ID, name: "Antigravity (Google CLI)", getModels: () => this.models,
      auth: { apiKey: { name: source,
        check: async () => installed() ? { type: "api_key", source } : undefined,
        resolve: async () => installed() ? { auth: {}, source } : undefined,
      } },
      refreshModels: context => this.refreshModels(context, installed()),
      stream: (model, context, request) => this.stream(model, context, request),
      streamSimple: (model, context, request) => this.stream(model, context, request, request),
    };
  }

  private stream(model: Model<Api>, context: TranscriptContext, request?: StreamOptions, simple?: SimpleStreamOptions) {
    const fail = (message: string, reason: "error" | "aborted" = "error") => {
      const response = new Response(model);
      response.finish(reason, message);
      return response.stream;
    };
    if (request?.signal?.aborted) return fail("Request was aborted", "aborted");
    try {
      const transcript = readTranscript(context);
      const scope = request?.sessionId;
      const piBinding = () => this.options.bindPi?.(scope);
      const cwd = piBinding()?.cwd ?? this.options.cwd ?? process.cwd();
      const loadout = (): Loadout => {
        const pi = piBinding()?.tools;
        const active = new Set(pi?.getActiveTools() ?? transcript.tools.map(tool => tool.name));
        const standIn = active.has(STAND_IN);
        return { active, standIn, tools: listTools(pi?.getAllTools() ?? transcript.tools, active, standIn) };
      };
      const live = loadout();
      // Pi 1.6 also hides the stand-in's declaration on ordinary turns, so an empty
      // list alone does not distinguish a summary. Compaction also disables cache retention.
      const toolless = simple?.toolChoice === "none" || !transcript.tools.length && request?.cacheRetention === "none";
      const requestLoadout: Loadout = toolless ? { active: new Set(), standIn: false, tools: [] } : live;
      const sections = forwardedSections(transcript.system, { cwd, root: projectRoot(cwd) });
      const responseRequest = { model, forwarded: sections, loadout: requestLoadout, reasoning: simple?.reasoning, options: request };
      this.sweep();
      if (!toolless) {
        for (const session of this.sessions) {
          const fresh = session.continues(scope, transcript.entries);
          if (fresh) return session.respond({ ...responseRequest, fresh, seed: false }).stream;
        }
        if ([...this.sessions].some(session => session.conflicts(scope, transcript.entries))) return fail("Antigravity is already processing this Pi conversation.");
        for (const session of this.sessions) if (session.paused && session.scope === scope) this.drop(session, "Pi changed the transcript; starting a new Antigravity session.");
      }
      if (transcript.entries.at(-1)?.kind === "wake") {
        const response = new Response(model);
        response.finish("stop");
        return response.stream;
      }
      const session = new AgentSession({ ...this.options, cwd, loadout, wake: id => piBinding()?.wake(id) ?? false,
        now: this.now, settled: () => this.sweep(),
        window: (id, size) => { const entry = this.models.find(model => model.id === id); if (entry) entry.contextWindow = size; },
      }, scope, model.id, sections, requestLoadout, toolless);
      this.sessions.add(session);
      this.sweeper ??= setInterval(() => this.sweep(), 60_000).unref();
      return session.respond({ ...responseRequest, fresh: transcript.entries, seed: true }).stream;
    } catch (error) {
      return fail(messageOf(error));
    }
  }

  route(scope: string, callId: string) {
    for (const session of this.sessions) if (session.scope === scope) {
      const call = session.route(callId);
      if (call) return call;
    }
  }

  rejectUnexecuted(scope: string, callId: string): void {
    for (const session of this.sessions) if (session.scope === scope) session.rejectUnexecuted(callId);
  }

  refreshTools(scope: string): void {
    for (const session of this.sessions) if (session.scope === scope) session.refreshTools();
  }

  async settled(scope: string): Promise<void> {
    for (const session of this.sessions) if (session.scope === scope) {
      await session.abandon();
      session.requestWake();
    }
  }

  private drop(session: AgentSession, reason?: string): void {
    this.sessions.delete(session);
    const closing = session.close(reason);
    this.retiring.add(closing);
    void closing.then(() => this.retiring.delete(closing), () => this.retiring.delete(closing));
  }

  private sweep(): void {
    const now = this.now();
    for (const session of this.sessions) {
      if (session.closed) this.drop(session);
      else if (session.spare && now - session.lastUsed >= (this.options.idleMs ?? 30 * 60_000)) this.drop(session);
    }
    const spare = [...this.sessions].filter(session => session.spare).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.sessions.size > (this.options.maxSessions ?? 4) && spare.length) this.drop(spare.shift()!);
    if (!this.sessions.size) { clearInterval(this.sweeper); this.sweeper = undefined; }
  }

  async closeSessions(): Promise<void> {
    this.epoch++;
    for (const session of this.sessions) this.drop(session);
    const probes = [...this.probes];
    this.probes.clear();
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.allSettled([...this.retiring, ...probes.map(probe => probe.close())]);
  }

  private async refreshModels(context: RefreshModelsContext, binary: string | undefined): Promise<void> {
    const { epoch } = this;
    const { stored, signal } = context;
    if (stored) {
      const restored: AntigravityModel[] = stored.models.flatMap(model => isModelType(model, "chat") && model.provider === PROVIDER_ID && model.api === API_ID
        ? [{ ...model, api: API_ID, compat: undefined }] : []);
      if (restored.length && !(await context.publish({ update: () => { if (epoch === this.epoch) this.models = restored; } }))) return;
    }
    if (!context.allowNetwork || signal.aborted || !binary || epoch !== this.epoch) return;
    const stat = statSync(binary);
    const etag = `acp-v1:${stat.mtimeMs}:${stat.size}`;
    if (!context.force && stored?.etag === etag && stored.checkedAt !== undefined && this.now() - stored.checkedAt < CATALOG_MAX_AGE_MS) return;
    const probe = new AgyProcess(this.options, appendPrompt("Antigravity", []), undefined, {
      update: () => {}, permission: () => ({ outcome: { outcome: "cancelled" } }),
      call: async () => failure("Model discovery does not run tools."), failed: () => {},
    });
    this.probes.add(probe);
    try {
      const models = catalog(await withSignal(probe.ready, signal)).map(row => row.model);
      if (models.length && !signal.aborted && epoch === this.epoch) await context.publish({
        persist: { models, checkedAt: this.now(), etag }, update: () => { if (epoch === this.epoch) this.models = models; },
      });
    } finally {
      await probe.close();
      this.probes.delete(probe);
    }
  }
}

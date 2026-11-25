import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, accessSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { client, methods, ndJsonStream, type ClientContext,
  type ContentBlock, type InitializeRequest, type InitializeResponse, type NewSessionRequest, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification } from "@agentclientprotocol/sdk";
import type { AgySessionResponse } from "./models.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolRequest, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { bridgeServer, failure } from "./tools.js";
import { messageOf, withSignal } from "./errors.js";

const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
const CLIENT_INFO = { name: "pi", title: "Pi", version };

const s = methods.agent.session;
const c = methods.client.session;

export function executable(env: NodeJS.ProcessEnv, override = env.PI_ANTIGRAVITY_AGY): string | undefined {
  return process.platform === "win32" ? undefined : findExecutable(env, override || "agy");
}

function findExecutable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const paths = isAbsolute(name) || name.includes("/") ? [resolve(name)] : (env.PATH ?? "").split(delimiter).map(dir => resolve(dir, name));
  return paths.find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
}

export interface ProcessOptions {
  cwd?: string;
  executable?: string;
  executableArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

interface Handlers {
  update(notification: SessionNotification): void;
  permission(request: RequestPermissionRequest): RequestPermissionResponse | Promise<RequestPermissionResponse>;
  call(request: CallToolRequest, signal: AbortSignal): Promise<CallToolResult>;
  failed(message: string): void;
}

export class AgyProcess {
  readonly ready: Promise<AgySessionResponse>;
  private readonly stop = Promise.withResolvers<void>();
  private readonly dying = new AbortController();
  private readonly mcpServers = new Set<Server>();
  private listed?: string;
  private readonly startup: AbortSignal;
  private readonly children = new Set<Socket>();
  private child?: ChildProcessWithoutNullStreams;
  private transport?: NetServer;
  private directory?: string;
  private context?: ClientContext;
  private sessionId?: string;
  private stderr = "";
  private closing?: Promise<void>;

  constructor(options: ProcessOptions, append: string, tools: (() => Tool[]) | undefined, private readonly handlers: Handlers) {
    this.startup = AbortSignal.any([this.dying.signal, AbortSignal.timeout(options.startupTimeoutMs ?? 20_000)]);
    this.ready = this.start(options, append, tools);
    void this.ready.catch(() => {});
  }

  private async start(options: ProcessOptions, append: string, tools: (() => Tool[]) | undefined): Promise<AgySessionResponse> {
    if (process.platform === "win32") throw new Error("Antigravity requires Unix-domain sockets; Windows is not supported.");
    const env = options.env ?? process.env;
    const binary = executable(env, options.executable);
    if (!binary) throw new Error("Antigravity CLI was not found. Install agy on PATH or set PI_ANTIGRAVITY_AGY.");
    const cwd = options.cwd ?? process.cwd();
    const mcpServers = tools ? [await this.listen(env, tools)] : [];
    this.startup.throwIfAborted();
    const { GEMINI_API_KEY: _gemini, GOOGLE_API_KEY: _google, ...childEnv } = env;
    const child = this.child = spawn(binary, [...options.executableArgs ?? [], "acp"], {
      cwd, env: childEnv, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4_000); });
    child.stdin.on("error", () => {});
    child.once("error", error => this.fail(`Could not start agy: ${error.message}`));
    child.once("exit", (code, signal) => this.fail(`agy exited (${signal ?? code ?? "unknown"}).`));
    const connected = Promise.withResolvers<AgySessionResponse>();
    const app = client({ name: CLIENT_INFO.name })
      .onRequest(c.requestPermission, ({ params }) => this.handlers.permission(params))
      .onNotification(c.update, ({ params }) => this.handlers.update(params));
    void app.connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>), async ctx => {
      this.context = ctx;
      const request = { cancellationSignal: this.startup, stopWaitingOnCancel: true };
      const init = await ctx.request<InitializeResponse, InitializeRequest>(methods.agent.initialize, {
        protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, request);
      const meta = init.agentCapabilities?._meta as { antigravity?: { systemPrompt?: { append?: boolean } } } | undefined;
      if (!meta?.antigravity?.systemPrompt?.append) throw new Error("This version of agy does not support appending Pi's system prompt.");
      const created = await ctx.request<AgySessionResponse, NewSessionRequest>(s.new, { cwd, mcpServers, _meta: { antigravity: { systemPrompt: { append } } } }, request);
      this.sessionId = created.sessionId;
      connected.resolve(created);
      await this.stop.promise;
    }).then(() => {
      if (!this.closing) this.fail("The ACP connection closed unexpectedly.");
    }, error => {
      connected.reject(error);
      this.fail(messageOf(error));
    });
    return withSignal(connected.promise, this.startup);
  }

  requestConfig(configId: string, value: string) {
    return this.context!.request(s.setConfigOption, { sessionId: this.sessionId!, configId, value },
      { cancellationSignal: AbortSignal.any([this.dying.signal, AbortSignal.timeout(15_000)]), stopWaitingOnCancel: true });
  }

  async prompt(prompt: ContentBlock[]) {
    try { return await this.context!.request(s.prompt, { sessionId: this.sessionId!, prompt }); }
    catch (error) {
      if (!/ACP connection closed/i.test(messageOf(error))) throw error;
      const child = this.child;
      const status = child?.exitCode ?? child?.signalCode;
      const detail = this.stderr.trim();
      throw new Error(`agy exited or closed its ACP connection${status === undefined || status === null ? "" : ` (${status})`}.${detail ? ` ${detail}` : ""}`, { cause: error });
    }
  }

  cancel(): void {
    if (this.sessionId) void this.context!.notify(s.cancel, { sessionId: this.sessionId }).catch(() => {});
  }

  private fail(message: string): void {
    if (this.closing) return;
    const detail = this.stderr.trim();
    const explanation = messageOf(new Error(detail ? `${message} ${detail}` : message));
    this.handlers.failed(explanation);
  }

  private async listen(env: NodeJS.ProcessEnv, tools: () => Tool[]) {
    // Pi's standalone Bun executable cannot run the shim as a JavaScript input file.
    const node = process.versions.bun ? findExecutable(env, "node") : process.execPath;
    if (!node) throw new Error("The Antigravity bridge needs Node.js on PATH when using the standalone Pi executable.");
    const parent = Buffer.byteLength(join(tmpdir(), "pa-XXXXXX", "s")) < 104 ? tmpdir() : "/tmp";
    this.directory = mkdtempSync(join(parent, "pa-"));
    const socketPath = join(this.directory, "s");
    const server = this.transport = createServer(socket => this.mcp(socket, tools));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    server.on("error", error => this.handlers.failed(error.message));
    return bridgeServer(node, socketPath);
  }

  toolsChanged(tools: Tool[]): void {
    const next = JSON.stringify(tools);
    if (this.listed !== undefined && this.listed !== next) {
      for (const server of this.mcpServers) void server.sendToolListChanged().catch(() => {});
    }
    this.listed = next;
  }

  private mcp(socket: Socket, tools: () => Tool[]): void {
    if (this.closing || this.children.size >= 2) { socket.destroy(); return; }
    this.children.add(socket);
    const server = new Server(CLIENT_INFO, { capabilities: { tools: { listChanged: true } } });
    this.mcpServers.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const listed = tools();
      this.listed = JSON.stringify(listed);
      return { tools: listed };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
      extra._meta?.["antigravity.google/conversation_id"] !== this.sessionId || !this.sessionId
        ? failure("Wrong Antigravity conversation for this Pi tool.") : this.handlers.call(request, extra.signal));
    const transport = new StdioServerTransport(socket, socket);
    socket.once("close", () => { this.children.delete(socket); this.mcpServers.delete(server); void server.close().catch(() => {}); });
    void server.connect(transport).catch(() => socket.destroy());
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(() => this.dispose());
  }

  private async dispose(): Promise<void> {
    this.dying.abort();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null && this.sessionId) {
      await this.context!.request(s.close, { sessionId: this.sessionId }, { cancellationSignal: AbortSignal.timeout(300), stopWaitingOnCancel: true }).catch(() => {});
    }
    this.stop.resolve();
    for (const socket of this.children) socket.destroy();
    this.transport?.close();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    if (child?.pid !== undefined) {
      const send = (signal: NodeJS.Signals | 0) => {
        try { process.kill(-child.pid!, signal); return true; } catch { return false; }
      };
      if (send("SIGTERM")) {
        for (let i = 0; i < 8 && send(0); i++) await delay(25);
        send("SIGKILL");
      }
    }
  }
}

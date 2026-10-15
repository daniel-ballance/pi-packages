import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
import { servePeer, type ManagementRequest } from "./peer-transport.js";

/** A negative RPC acknowledgement proves the command was not accepted. */
export class RpcRejectedError extends Error {}

export type Packet = Record<string, any>;

/** Strict LF framing. Unicode line separators are valid JSON string content. */
export class JsonlDecoder {
  private buffer = "";
  constructor(private receive: (packet: Packet) => void, private maxBytes = 8 * 1024 * 1024) {}
  push(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error(`JSONL record exceeded ${this.maxBytes} bytes`);
      if (line.trim()) this.receive(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error(`Unterminated JSONL record exceeded ${this.maxBytes} bytes`);
  }
}

export class RpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private ended = false;
  private stopping?: Promise<void>;
  private killing?: Promise<void>;
  private failure?: Error;
  constructor(options: {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    event: (packet: Packet) => void; stderr: (text: string) => void;
    exit: (error?: Error) => void;
    peerRequest?: (packet: Packet) => Promise<unknown>;
    manageRequest?: (request: ManagementRequest, signal: AbortSignal) => Promise<unknown>;
  }) {
    const env = { ...options.env };
    delete env.PI_SUBAGENT_PEER_FD;
    const privatePipe = !!(options.peerRequest || options.manageRequest);
    if (privatePipe) env.PI_SUBAGENT_PEER_FD = "3";
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd, env, stdio: privatePipe ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    const fail = (error: Error) => {
      this.failure = error;
      this.rejectAll(error);
      void this.stop();
    };
    const decoder = new JsonlDecoder(packet => {
      if (packet.type === "response" && typeof packet.id === "string") {
        const waiter = this.pending.get(packet.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.pending.delete(packet.id);
          if (packet.success) waiter.resolve(packet.data);
          else waiter.reject(new RpcRejectedError(packet.error || "RPC command failed"));
        }
      }
      options.event(packet);
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => {
      try { decoder.push(chunk); } catch (error) { fail(error as Error); }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", options.stderr);
    this.child.stdin.on("error", error => fail(error));
    this.child.on("error", error => fail(error));
    this.closed = new Promise(resolve => {
      this.child.once("close", (code, signal) => {
        this.ended = true;
        const error = this.failure ?? (code === 0 ? undefined : new Error(`Child exited: code=${code}, signal=${signal}`));
        this.rejectAll(error ?? new Error("Child exited"));
        options.exit(error);
        resolve();
      });
    });
    if (privatePipe) {
      const peer = this.child.stdio[3] as Duplex | null;
      try {
        if (!peer) throw new Error("Failed to attach managed peer pipe");
        servePeer(peer, options.peerRequest, options.manageRequest);
      } catch (error) { fail(error as Error); }
    }
  }
  private rejectAll(error: Error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  request(command: Packet, timeoutMs = 30000): Promise<any> {
    if (this.ended || this.stopping || this.killing) return Promise.reject(new Error("Child is stopped or stopping"));
    const id = `request-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${command.type} timed out; acceptance may be unknown. Inspect state before retrying.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n", error => {
        if (error) {
          clearTimeout(timer); this.pending.delete(id); reject(error);
        }
      });
    });
  }
  /** UI responses have no protocol acknowledgement; this resolves only when transport accepts the write. */
  respond(packet: Packet): Promise<void> {
    if (this.ended || this.stopping || this.killing) return Promise.reject(new Error("Child is stopped or stopping"));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(packet) + "\n", error => error ? reject(error) : resolve());
    });
  }
  private signal(signal: NodeJS.Signals, strict = false): Error | undefined {
    if (this.ended) return;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else if (!this.child.kill(signal) && strict) return new Error(`${signal} was not sent to the child`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.failure = error as Error;
      if (strict) return error as Error;
    }
  }
  /** Human kill is immediate, bounded and only confirmed after observed process close. */
  kill(timeoutMs = 2000): Promise<void> {
    if (this.ended) return Promise.resolve();
    if (this.killing) return this.killing;
    const failure = this.signal("SIGKILL", true);
    if (failure) return Promise.reject(failure);
    let timer: NodeJS.Timeout;
    const bounded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`SIGKILL sent but process close was not confirmed within ${timeoutMs}ms`)), timeoutMs);
      void this.closed.then(resolve, reject);
    });
    this.killing = bounded.finally(() => {
      clearTimeout(timer);
      this.killing = undefined; // A failed/unconfirmed kill can be retried.
    });
    return this.killing;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.killing) return this.killing;
    if (this.ended) return Promise.resolve();
    this.stopping = (async () => {
      // Pi's SIGTERM handler runs session_shutdown; bound that grace period.
      this.signal("SIGTERM");
      const killer = setTimeout(() => this.signal("SIGKILL"), 2000);
      try { await this.closed; } finally { clearTimeout(killer); }
    })();
    return this.stopping;
  }
}

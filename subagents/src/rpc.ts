import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("RPC record exceeded 8 MiB");
      if (line.trim()) this.receive(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error("Unterminated RPC record exceeded 8 MiB");
  }
}

export class RpcChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private ended = false;
  private stopping?: Promise<void>;
  private failure?: Error;
  constructor(options: {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    event: (packet: Packet) => void; stderr: (text: string) => void;
    exit: (error?: Error) => void;
  }) {
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
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
          else waiter.reject(new Error(packet.error || "RPC command failed"));
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
  }
  private rejectAll(error: Error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  request(command: Packet, timeoutMs = 30000): Promise<any> {
    if (this.ended || this.stopping) return Promise.reject(new Error("Child is stopped or stopping"));
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
  /** UI responses are protocol messages, not acknowledged RPC commands. */
  respond(packet: Packet) {
    if (this.ended || this.stopping) throw new Error("Child is stopped or stopping");
    this.child.stdin.write(JSON.stringify(packet) + "\n");
  }
  private signal(signal: NodeJS.Signals) {
    if (this.ended) return;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.failure = error as Error;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
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

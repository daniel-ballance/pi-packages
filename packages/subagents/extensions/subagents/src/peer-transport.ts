import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { read, write as writeFd, close as closeFd } from "node:fs";
import { JsonlDecoder, type Packet } from "./rpc.js";
import { isManagementOp, type ManagementOp } from "./nesting.js";

const MAX_FRAME = 64 * 1024;
const MAX_PENDING = 8;
function write(socket: Duplex, packet: Packet) {
  if (socket.destroyed || socket.writableLength > MAX_FRAME) throw new Error("Peer transport unavailable or backpressured; acceptance may be unknown. Do not retry blindly.");
  socket.write(JSON.stringify(packet) + "\n");
}
export type ManagementRequest = { op: ManagementOp; args: Record<string, unknown> };
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Private inherited pipe: the owner supplies sender identity, never the packet.
 * Two request shapes share it: a peer message, and (for a Child allowed to
 * delegate) a management call that the root Manager scopes to the sender's subtree. */
export function servePeer(socket: Duplex, receive?: (packet: Packet) => Promise<unknown>, manage?: (request: ManagementRequest) => Promise<unknown>) {
  let active = 0;
  let sequence = 0;
  const decoder = new JsonlDecoder(packet => {
    if (!packet || !Number.isSafeInteger(packet.id) || packet.id <= sequence) throw new Error("Invalid/replayed peer request ID");
    sequence = packet.id;
    if ("op" in packet) {
      if (!manage || Object.keys(packet).some(key => !["id", "op", "args"].includes(key)) || !isManagementOp(packet.op) || !isPlainObject(packet.args)) {
        write(socket, { id: packet.id, success: false, error: "Invalid management request, or delegation is not enabled for this Child." }); return;
      }
      dispatch(packet, () => manage({ op: packet.op, args: packet.args }));
      return;
    }
    if (!receive || Object.keys(packet).some(key => !["id", "recipient", "message"].includes(key)) ||
        typeof packet.recipient !== "string" || !packet.recipient || packet.recipient.length > 120 ||
        typeof packet.message !== "string" || !packet.message.trim() || packet.message.length > 4000) {
      write(socket, { id: packet.id, success: false, error: "Invalid peer request; only recipient and message are accepted." }); return;
    }
    dispatch(packet, () => receive(packet));
  }, MAX_FRAME);
  function dispatch(packet: Packet, run: () => Promise<unknown>) {
    if (active >= MAX_PENDING) {
      write(socket, { id: packet.id, success: false, error: "Too many pending requests (maximum 8)." }); return;
    }
    active++;
    void Promise.resolve().then(run).then(
      data => write(socket, { id: packet.id, success: true, data }),
      error => write(socket, { id: packet.id, success: false, error: String(error).slice(0, 2000) }),
    ).catch(() => socket.destroy()).finally(() => active--);
  }
  socket.setEncoding("utf8");
  socket.on("data", chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
  socket.on("error", () => socket.destroy());
}

/** Bun's node:net Socket({fd}) cannot adopt this inherited socket. Use bounded
 * asynchronous descriptor I/O there; Node uses its native socket implementation. */
class DescriptorDuplex extends Duplex {
  private reading = false;
  private retry?: NodeJS.Timeout;
  constructor(private fd: number) { super(); }
  _read(size: number) {
    if (this.reading || this.destroyed) return;
    this.reading = true;
    const buffer = Buffer.alloc(Math.min(size, MAX_FRAME));
    const attempt = () => {
      if (this.destroyed) return;
      read(this.fd, buffer, 0, buffer.length, null, (error, bytes) => {
        if (this.destroyed) return;
        if (error && ["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code ?? "")) { this.retry = setTimeout(attempt, 10); return; }
        this.reading = false;
        if (error) this.destroy(error);
        else this.push(bytes ? buffer.subarray(0, bytes) : null);
      });
    };
    attempt();
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    let offset = 0;
    const attempt = () => {
      if (this.destroyed) { done(new Error("Peer transport closed")); return; }
      writeFd(this.fd, chunk, offset, chunk.length - offset, null, (error, bytes) => {
        if (error && ["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code ?? "")) { setTimeout(attempt, 10); return; }
        if (error) { done(error); return; }
        offset += bytes;
        if (offset < chunk.length) attempt(); else done();
      });
    };
    attempt();
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void) {
    clearTimeout(this.retry); closeFd(this.fd, () => done(error));
  }
}

export class PeerClient {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }>();
  constructor(private socket: Duplex) {
    const decoder = new JsonlDecoder(packet => {
      const waiter = this.pending.get(packet.id);
      if (!waiter) return;
      this.pending.delete(packet.id); waiter.cleanup();
      if (packet.success === true) waiter.resolve(packet.data);
      else waiter.reject(new Error(packet.error || "Peer send rejected"));
    }, MAX_FRAME);
    socket.setEncoding("utf8");
    socket.on("data", chunk => { try { decoder.push(chunk); } catch { this.close(); } });
    socket.on("error", error => this.close(error));
    socket.on("close", () => this.close());
  }
  static fromEnvironment() {
    if (process.env.PI_SUBAGENT !== "1" || process.env.PI_SUBAGENT_PEER_FD !== "3") throw new Error("No managed peer transport");
    return new PeerClient(process.versions.bun ? new DescriptorDuplex(3) : new Socket({ fd: 3, readable: true, writable: true }));
  }
  send(recipient: string, message: string, signal?: AbortSignal, timeoutMs = 35000): Promise<unknown> {
    return this.request({ recipient, message }, signal, timeoutMs, "Peer send interrupted or timed out; acceptance may be unknown. Ask the parent to inspect; do not retry blindly.");
  }
  /** A delegation call to the root Manager; waits may take up to a minute. */
  manage(op: ManagementOp, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 90000): Promise<unknown> {
    return this.request({ op, args }, signal, timeoutMs, `subagent_${op} interrupted or timed out; its effect may be unknown. Inspect with subagent_list before retrying.`);
  }
  private request(body: Packet, signal: AbortSignal | undefined, timeoutMs: number, interrupted: string): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.pending.size >= MAX_PENDING) throw new Error("Too many pending requests to the parent manager");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const fail = () => {
        this.pending.delete(id); cleanup();
        reject(new Error(interrupted));
      };
      const timer = setTimeout(fail, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", fail); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", fail, { once: true });
      try { write(this.socket, { id, ...body }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  close(cause?: Error) {
    for (const waiter of this.pending.values()) {
      waiter.cleanup(); waiter.reject(new Error(`Peer transport closed${cause ? ` (${cause.message})` : ""}; acceptance may be unknown. Ask the parent to inspect before retrying.`));
    }
    this.pending.clear(); this.socket.destroy();
  }
}

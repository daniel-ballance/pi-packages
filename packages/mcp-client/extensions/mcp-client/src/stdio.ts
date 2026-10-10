import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config.js';
import { deadline, MAX_MESSAGE_BYTES } from './limits.js';

const USE_PROCESS_GROUPS = process.platform !== 'win32';
const GRACE_MS = 250;
const KILL_WAIT_MS = 1000;

/** Newline framing with a byte limit. Unlike SDK v1's parser, accepts legacy batches. */
export class StdioTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing?: Promise<void>;
  private exitObserved = false;
  private closeNotified = false;
  private exited?: Promise<void>;
  private pipesClosed?: Promise<void>;
  // Only a detached child's PID may be used as a process-group ID. Never use 0
  // or a discovered/inherited group (which could include the Pi host).
  private group?: number;
  constructor(private config: Extract<ServerConfig, { transport: 'stdio' }>) {}
  async start() {
    if (this.closed) throw new Error('MCP stdio closed');
    if (this.child) throw new Error('MCP stdio already started');
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...getDefaultEnvironment(), ...this.config.env },
      stdio: 'pipe',
      shell: false,
      detached: USE_PROCESS_GROUPS,
      windowsHide: true,
    });
    this.child = child;
    if (USE_PROCESS_GROUPS && child.pid && child.pid > 1 && child.pid !== process.pid)
      this.group = child.pid;
    this.exited = new Promise<void>((resolve) => {
      const exited = () => {
        this.exitObserved = true;
        resolve();
        // A wrapper can exit before its descendants. Keep ownership until tree
        // cleanup finishes, even if every inherited pipe has already closed.
        void this.close().catch(() => {});
      };
      child.once('exit', exited);
      child.on('error', (error) => {
        if (!child.pid) exited(); // Spawn failure has no 'exit' event.
        if (!this.closed) this.onerror?.(error);
      });
    });
    this.pipesClosed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
        this.notifyClose();
      });
    });
    let chunks: Buffer[] = [],
      bytes = 0;
    child.stderr.resume(); // Never retain or leak subprocess diagnostics/secrets.
    const onerror = (error: Error) => {
      if (!this.closed) this.onerror?.(error);
    };
    child.stdin.on('error', onerror);
    child.stdout.on('error', onerror);
    child.stderr.on('error', onerror);
    child.stdout.on('data', (chunk: Buffer) => {
      // 'exit' can precede the last buffered stdout frame. Drain those frames
      // before onclose, while Peer suppresses replies after explicit shutdown.
      if (this.closed && !this.exitObserved) return;
      try {
        let start = 0;
        for (let end = 0; end <= chunk.length; end++) {
          if (end !== chunk.length && chunk[end] !== 10) continue;
          const part = chunk.subarray(start, end);
          bytes += part.length;
          if (bytes > MAX_MESSAGE_BYTES) throw new Error('MCP stdio message exceeds 10 MiB');
          chunks.push(part);
          if (end < chunk.length) {
            const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
            const message = Array.isArray(value)
              ? value.map((item) => JSONRPCMessageSchema.parse(item))
              : JSONRPCMessageSchema.parse(value);
            if (Array.isArray(message) && (!message.length || message.length > 1000))
              throw new Error('Invalid or oversized MCP batch');
            this.onmessage?.(message as JSONRPCMessage);
            chunks = [];
            bytes = 0;
          }
          start = end + 1;
        }
      } catch (error) {
        this.onerror?.(error as Error);
        void this.close().catch(() => {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (this.closed) throw new Error('MCP stdio closed');
  }
  async send(message: JSONRPCMessage) {
    if (!this.child || this.closed) throw new Error('MCP stdio closed');
    const text = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('MCP request exceeds 10 MiB');
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(text, (error) => (error ? reject(error) : resolve()));
    });
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      // Publish before callbacks can reenter close(). All callers await cleanup.
      this.closing = Promise.resolve().then(() => this.closeOwnedProcess());
    }
    return this.closing;
  }
  private notifyClose() {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }
  private groupExists() {
    if (!this.group) return false;
    try {
      process.kill(-this.group, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
  private signalOwnedProcess(signal: NodeJS.Signals) {
    if (this.group) {
      try {
        process.kill(-this.group, signal);
        return;
      } catch {
        // A group may already be gone, or group signaling may be unavailable.
      }
    }
    if (!this.exitObserved) this.child?.kill(signal);
  }
  private async waitForTree(ms: number) {
    const end = Date.now() + ms;
    while (!this.exitObserved || this.groupExists()) {
      if (Date.now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, end - Date.now())));
    }
    return true;
  }
  private async closeOwnedProcess() {
    const child = this.child;
    if (!child) {
      this.notifyClose();
      return;
    }
    try {
      child.stdin.end();
      if (await this.waitForTree(GRACE_MS)) return;
      if (process.platform === 'win32' && child.pid && !this.exitObserved) {
        // Windows has no owned POSIX groups. taskkill includes descendants of
        // wrappers; bound and reap the helper too. No shell or global process scan.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        const done = new Promise<void>((resolve) => {
          killer.once('exit', () => resolve());
          killer.once('error', () => resolve());
        });
        try {
          await deadline(done, GRACE_MS);
        } catch {
          killer.kill();
          await deadline(done, GRACE_MS).catch(() => {});
        }
      } else this.signalOwnedProcess('SIGTERM');
      if (await this.waitForTree(GRACE_MS)) return;
      this.signalOwnedProcess('SIGKILL');
      // Sending SIGKILL is not proof of exit. Await the direct child's actual
      // exit, bounded even for uninterruptible OS I/O. Descendant zombies cannot
      // be reaped by us; they may keep the group visible until their parent reaps.
      await Promise.all([deadline(this.exited!, KILL_WAIT_MS), this.waitForTree(KILL_WAIT_MS)]);
    } finally {
      // Drain a normally exiting child's final frames, but do not hang on pipes
      // inherited by descendants that escaped the owned group.
      if (this.exitObserved) await deadline(this.pipesClosed!, GRACE_MS).catch(() => {});
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      this.group = undefined;
      this.notifyClose();
    }
  }
}

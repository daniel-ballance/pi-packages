import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Launch } from './installation.js';

/** Own the launcher AND its REPL/app-server children; never kill the shared GUI app. */
export class RuntimeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private closing?: Promise<void>;
  private buffer = new ReadBuffer({ maxBufferSize: 16 * 1024 * 1024 });
  stderr = '';

  constructor(private launch: Launch) {}

  get pid(): number | undefined { return this.child?.pid; }

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error('Computer Use transport is already started or closed.');
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: { ...getDefaultEnvironment(), ...this.launch.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString('utf8')).slice(-4096);
    });
    child.stdout.on('data', (data: Buffer) => {
      if (this.closed) return;
      try {
        this.buffer.append(data);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
    child.stdin.on('error', error => { if (!this.closed) this.onerror?.(error); });
    child.stdout.on('error', error => { if (!this.closed) this.onerror?.(error); });
    child.on('close', () => { void this.close(); });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => { this.onerror?.(error); reject(error); });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.closed) throw new Error('Computer Use transport is disconnected.');
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.teardown();
    return this.closing;
  }

  private async teardown(): Promise<void> {
    const child = this.child;
    this.onclose?.();
    if (!child?.pid) return;
    const pid = child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
    };
    // SIGTERM normally exits the signed launcher and REPL promptly. Kill the
    // group again after the grace period even if the launcher exited first.
    kill('SIGTERM');
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise<void>(resolve => child.once('close', resolve));
    await Promise.race([exited, delay(500, undefined, { ref: false })]);
    kill('SIGKILL');
    await Promise.race([exited, delay(500, undefined, { ref: false })]);
    this.buffer.clear();
    this.child = undefined;
  }
}

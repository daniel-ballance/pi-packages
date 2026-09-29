import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config.js';
import { deadline, MAX_MESSAGE_BYTES } from './limits.js';

/** Newline framing with a byte limit. Unlike SDK v1's parser, accepts legacy batches. */
export class StdioTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  constructor(private config: Extract<ServerConfig, { transport: 'stdio' }>) {}
  async start() {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...getDefaultEnvironment(), ...this.config.env },
      stdio: 'pipe',
      shell: false,
    });
    this.child = child;
    let chunks: Buffer[] = [],
      bytes = 0;
    child.stderr.resume(); // Never retain or leak subprocess diagnostics/secrets.
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.stdout.on('data', (chunk: Buffer) => {
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
        void this.close();
      }
    });
    child.once('close', () => {
      this.closed = true;
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  }
  async send(message: JSONRPCMessage) {
    if (!this.child || this.closed) throw new Error('MCP stdio closed');
    const text = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('MCP request exceeds 10 MiB');
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(text, (error) => (error ? reject(error) : resolve()));
    });
  }
  async close() {
    const child = this.child;
    if (!child || this.closed) return;
    const exited = new Promise<void>((resolve) => child.once('close', resolve));
    child.stdin.end();
    try {
      await deadline(exited, 250);
    } catch {
      child.kill('SIGTERM');
      try {
        await deadline(exited, 250);
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
}

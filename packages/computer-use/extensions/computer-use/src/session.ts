import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { detectInstallation, type Installation } from './installation.js';
import { sessionConsent } from './consent.js';
import { RuntimeTransport } from './transport.js';

export type Code = { code: string; title?: string; timeout_ms?: number };

export class ComputerSession {
  private client?: Client;
  private transport?: RuntimeTransport;
  private lifetime = new AbortController();
  private active?: { signal: AbortSignal; client: Client };
  private busy = false;
  private grants = new Set<string>();
  private used = false;
  private closing?: Promise<void>;

  constructor(
    private detect: () => Installation = detectInstallation,
    private timeout = 120_000,
    private startupTimeout = 20_000,
  ) {}

  get connected(): boolean { return this.client?.getServerVersion() !== undefined; }

  async execute(args: Code, signal?: AbortSignal): Promise<CallToolResult> {
    if (this.busy || this.closing) throw new Error('Computer Use is busy. Run computer-use calls sequentially.');
    if (!args.code.trim()) throw new Error('Computer Use requires non-empty JavaScript code.');
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 120_000)) {
      throw new Error('timeout_ms must be an integer from 1 to 120000.');
    }
    signal?.throwIfAborted();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const lifetime = this.lifetime.signal;
    const operationSignal = AbortSignal.any([lifetime, AbortSignal.timeout(this.timeout), ...(signal ? [signal] : [])]);
    this.busy = true;
    let dispatched = false;
    try {
      const client = await this.connect(operationSignal);
      operationSignal.throwIfAborted();
      this.active = { signal: operationSignal, client };
      this.used = true;
      dispatched = true;
      const result = await client.callTool({ name: 'js', arguments: args }, CallToolResultSchema, {
        signal: operationSignal, timeout: this.timeout,
      });
      return CallToolResultSchema.parse(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.close();
      throw new Error(`Computer Use failed: ${detail.slice(0, 2000)}${dispatched ? ' The action may have partially completed. Inspect the app state before repeating it.' : ''}`);
    } finally {
      this.active = undefined;
      this.busy = false;
    }
  }

  private async connect(signal: AbortSignal): Promise<Client> {
    if (this.connected) return this.client!;
    signal.throwIfAborted();
    const installation = this.detect();
    if (!installation.available) throw new Error(installation.reason);
    const client = new Client({ name: 'pi-computer-use', version: '0.1.0' }, {
      capabilities: { elicitation: { form: {} } },
    });
    const transport = new RuntimeTransport(installation.launch);
    const lifetime = this.lifetime;
    this.client = client;
    this.transport = transport;
    // Consent belongs only to an active tool call on this connection. There are
    // no Pi dialogs, permanent grants, generic forms, URL flows, or sampling.
    client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
      const active = this.active;
      if (!active || active.client !== client || active.signal.aborted || extra.signal.aborted) return { action: 'cancel' };
      return sessionConsent(request.params, this.grants);
    });
    client.onclose = () => {
      lifetime.abort(new Error('The computer-use runtime disconnected.'));
      if (this.client === client) { this.client = undefined; this.grants.clear(); }
    };
    // Errors become failed requests/closed transports; they never write into the Pi TUI.
    client.onerror = () => {};
    const startup = AbortSignal.any([signal, AbortSignal.timeout(this.startupTimeout)]);
    try {
      await client.connect(transport, { signal: startup, timeout: this.startupTimeout });
      const catalog = await client.listTools({}, { signal: startup, timeout: this.startupTimeout });
      if (!catalog.tools.some(tool => tool.name === 'js')) throw new Error('The installed runtime does not expose its js tool. Update ChatGPT.');
      startup.throwIfAborted();
      return client;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}${transport.stderr ? `\nRuntime: ${transport.stderr}` : ''}`);
    }
  }

  async endTurn(sessionId: string, turnId: string): Promise<void> {
    if (!this.connected || !this.used || this.busy || this.closing) return;
    this.used = false;
    // Host cleanup is deliberately not a model-facing tool.
    try {
      await this.client!.callTool({ name: 'turn_ended', arguments: {
        hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId,
      } }, undefined, { timeout: 5000, signal: this.lifetime.signal });
    } catch { await this.close(); }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.active = undefined;
    this.used = false;
    this.grants.clear();
    this.lifetime.abort(new Error('Computer Use session closed.'));
    this.lifetime = new AbortController();
    this.closing = (async () => {
      try { await client?.close(); }
      finally { await transport?.close(); }
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
